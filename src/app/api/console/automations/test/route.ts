// =====================================================================
// /api/console/automations/test
//
// POST { workspace, agent?, trigger_id?, ...trigger }  -> fire ONE test push.
//
// Sends the same body a real matched call would send, built by the same
// buildRequest() the engine uses, but from a fake sample context (see
// sample-context.ts). That's what makes the CRM side mappable before any real
// call exists: the endpoint receives the exact field names production will send,
// with obviously-fake values.
//
// It takes the trigger DEFINITION in the body rather than an id, so the console
// can test an automation that hasn't been saved yet (and test unsaved edits to
// one that has). The push is recorded in automation_runs with meta.test = true
// so the run log shows it, and it never touches dedupe for real contacts — the
// sample contact phone is a reserved fictitious number.
//
// Admin (cross-org) gated, like the rest of /api/console/automations*.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";
import { resolveConsoleWorkspace, resolveConsoleAgent } from "@/lib/console/resolve-agent";
import { buildRequest, resolveLinkType } from "@/lib/engine/automations/build-request";
import { buildSampleContext } from "@/lib/engine/automations/sample-context";
import { automationTriggerCreateSchema } from "@/lib/engine/automations/schema";
import type { AutomationActionConfig } from "@/lib/engine/automations/types";
import type { Json } from "@/types/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Matches the executor's request timeout so a test fails the way prod fails. */
const REQUEST_TIMEOUT_MS = 10_000;

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const json = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json || typeof json !== "object") {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const workspaceName = String(json.workspace ?? "").trim();
  const agentName =
    typeof json.agent === "string" && json.agent.trim() ? json.agent.trim() : undefined;
  const triggerId =
    typeof json.trigger_id === "string" && json.trigger_id.trim() ? json.trigger_id.trim() : null;
  if (!workspaceName) {
    return NextResponse.json({ error: "missing { workspace: <name> }" }, { status: 400 });
  }

  const parsed = automationTriggerCreateSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid trigger", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const trigger = parsed.data;
  const config = (trigger.action_config ?? {}) as AutomationActionConfig;

  const db = createServiceClient();
  const ws = await resolveConsoleWorkspace(db, workspaceName);
  if (!ws.ok) return NextResponse.json({ error: ws.error }, { status: ws.status });

  let agentId: string | null = null;
  if (agentName) {
    const resolved = await resolveConsoleAgent(db, workspaceName, agentName);
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }
    agentId = resolved.agent.id;
  }

  // Only attribute the logged run to a trigger that really is this workspace's —
  // a stale id would fail the insert and lose the audit record entirely.
  let runTriggerId: string | null = null;
  if (triggerId) {
    const { data: owned } = await db
      .from("automation_triggers")
      .select("id")
      .eq("id", triggerId)
      .eq("workspace_id", ws.workspace.id)
      .maybeSingle();
    runTriggerId = owned?.id ?? null;
  }

  // The workspace link map, so the sample can pick a link_type that resolves.
  const { data: linkRows } = await db
    .from("automation_links")
    .select("link_type, url, label")
    .eq("workspace_id", ws.workspace.id)
    .order("link_type", { ascending: true });
  const links = linkRows ?? [];

  const sample = buildSampleContext(trigger, { linkTypes: links.map((l) => l.link_type) });

  const linkType = resolveLinkType(config, sample.ctx);
  const mapped = linkType ? links.find((l) => l.link_type === linkType) : undefined;
  const link = {
    type: linkType,
    url: mapped?.url ?? null,
    label: mapped?.label ?? null,
  };

  const built = buildRequest(
    { name: trigger.name, action_type: trigger.action_type, action_config: config },
    sample.ctx,
    link
  );

  // Flag the default payload so the receiving side can tell a test from a lead.
  // A custom payload_template is sent byte-for-byte as configured — its whole
  // point is that the CRM sees exactly the shape it will get in production.
  const payload: Record<string, unknown> = config.payload_template
    ? built.payload
    : { test: true, ...built.payload };

  const warnings: string[] = [];
  if (!sample.matches) {
    warnings.push(
      "The sample data does not satisfy this automation's own conditions, so a real call " +
        "shaped like this would not fire it. The push below was still sent."
    );
  }
  if (linkType && !mapped) {
    warnings.push(
      `link_type "${linkType}" is not in this workspace's link map, so link_url is empty.`
    );
  }

  // internal_notify has no URL (the schema requires one for every other action),
  // so there is nothing to push — return the payload as a preview instead.
  if (!built.url) {
    return NextResponse.json({
      ok: true,
      delivered: false,
      reason:
        "Internal notify records the match instead of calling out — nothing was sent. " +
        "This is the payload it would record.",
      url: null,
      method: "POST",
      payload,
      matched: sample.matches,
      warnings,
    });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Lets a shared endpoint drop test traffic without a separate URL.
    "X-UpSurge-Test": "true",
    ...(config.headers ?? {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  let status = 0;
  let body = "";
  let threw: unknown = null;
  try {
    // POST, like executeAutomationRun — a test must fail the way prod fails.
    const res = await fetch(built.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    status = res.status;
    body = (await res.text().catch(() => "")).slice(0, 2000);
  } catch (err) {
    threw = err;
  } finally {
    clearTimeout(timer);
  }
  const durationMs = Date.now() - startedAt;

  const delivered = !threw && status >= 200 && status < 300;
  const error = threw
    ? threw instanceof Error
      ? threw.message
      : String(threw)
    : delivered
      ? null
      : `HTTP ${status}: ${body}`;

  // Audit the test in the run log alongside real deliveries. Best-effort: a
  // logging failure must not hide the delivery result from the operator.
  const { error: logError } = await db
    .from("automation_runs")
    .insert({
      workspace_id: ws.workspace.id,
      trigger_id: runTriggerId,
      agent_id: agentId,
      contact_phone: sample.ctx.contact.phone,
      status: delivered ? "sent" : "dead",
      attempts: 1,
      max_attempts: 1,
      action_type: trigger.action_type,
      request_url: built.url,
      request_payload: payload as unknown as Json,
      response_status: status || null,
      response_body: body || null,
      last_error: error?.slice(0, 1000) ?? null,
      sent_at: delivered ? new Date().toISOString() : null,
      meta: {
        test: true,
        trigger_name: trigger.name,
        link_type: link.type,
        link_url: link.url,
        headers: config.headers ?? undefined,
      } as unknown as Json,
    });
  if (logError) {
    console.warn("[automations/test] could not log the test run:", logError.message);
  }

  return NextResponse.json({
    ok: delivered,
    delivered,
    url: built.url,
    method: "POST",
    payload,
    response_status: status || null,
    response_body: body || null,
    duration_ms: durationMs,
    matched: sample.matches,
    warnings,
    error,
  });
}
