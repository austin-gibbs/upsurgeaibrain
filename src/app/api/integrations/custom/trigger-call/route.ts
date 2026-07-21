// =====================================================================
// POST /api/integrations/custom/trigger-call
//
// On-demand outbound call for the custom integration (e.g. SellMyFISBO's
// "Add to AI Campaign" button). The external app authenticates with a bearer
// API key and sends BOTH the lead and the triggering real-estate agent. We:
//   1. Authenticate the key -> workspace + outbound agent.
//   2. Upsert a local `contacts` row keyed by (workspace_id, lead.id), stashing
//      the merged lead+agent fields in `dynamic_var_overrides` so caller.ts
//      injects them into the Retell prompt ({{homeowner_name}}, {{agent_name}}…).
//   3. Place ONE call inline via placeCall(testMode) — no poll, no enroll tag,
//      no call-window gate. FUB/HighLevel code paths are never touched.
//
// This endpoint is service-role backed and CRM-agnostic; it does not read or
// write any Follow Up Boss / HighLevel state.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { placeCall } from "@/lib/engine/caller";
import { customTriggerCallSchema } from "@/lib/validation";
import { bearerFromHeader, resolveApiKey } from "@/lib/integrations/custom/api-key";
import type { Agent, Contact } from "@/types";

export const runtime = "nodejs";

/** Map the validated lead + agent payload into Retell dynamic variables. */
function buildOverrides(
  input: ReturnType<typeof customTriggerCallSchema.parse>
): Record<string, string> {
  const { lead, agent, variables } = input;
  const out: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === "") return;
    out[k] = String(v);
  };

  // Lead (FSBO homeowner)
  put("homeowner_name", lead.name);
  put("property_address", lead.property_address);
  put("property_city", lead.property_city);
  put("listing_price", lead.listing_price);
  put("days_on_market", lead.days_on_market);

  // Triggering real-estate agent
  put("agent_name", agent.name);
  put("agent_company", agent.company);
  put("agent_phone", agent.phone);
  put("agent_email", agent.email);

  // Forward-compatible extras (verbatim; do not override the mapped keys above).
  if (variables) {
    for (const [k, v] of Object.entries(variables)) {
      if (!(k in out)) put(k, v);
    }
  }
  return out;
}

export async function POST(req: NextRequest) {
  const token = bearerFromHeader(req.headers.get("authorization"));
  if (!token) {
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });
  }
  const key = await resolveApiKey(token);
  if (!key) {
    return NextResponse.json({ error: "invalid or inactive API key" }, { status: 401 });
  }

  const json = await req.json().catch(() => null);
  const parsed = customTriggerCallSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const input = parsed.data;

  const supabase = createServiceClient();

  // Resolve the outbound agent this key places calls through.
  if (!key.agentId) {
    return NextResponse.json(
      { error: "API key is not bound to an agent" },
      { status: 409 }
    );
  }
  const { data: agent } = await supabase
    .from("agents")
    .select("*")
    .eq("id", key.agentId)
    .eq("workspace_id", key.workspaceId)
    .single<Agent>();
  if (!agent) {
    return NextResponse.json({ error: "bound agent not found" }, { status: 404 });
  }
  if (agent.direction !== "outbound") {
    return NextResponse.json(
      { error: "bound agent is not outbound" },
      { status: 409 }
    );
  }
  if (!agent.retell_agent_id || !agent.retell_from_number) {
    return NextResponse.json(
      { error: "bound agent is missing its Retell agent ID or from number" },
      { status: 409 }
    );
  }

  const overrides = buildOverrides(input);

  // Upsert the local contact keyed by (workspace_id, lead.id). Re-triggering the
  // same lead reuses one row and refreshes its dynamic variables. attempt_count
  // is left to the DB default on insert; not reset on update.
  const { data: contact, error: upsertErr } = await supabase
    .from("contacts")
    .upsert(
      {
        workspace_id: key.workspaceId,
        crm_contact_id: input.lead.id,
        full_name: input.lead.name ?? null,
        email: input.lead.email ?? null,
        phones: [input.lead.phone],
        tags: [],
        dynamic_var_overrides: overrides,
      },
      { onConflict: "workspace_id,crm_contact_id" }
    )
    .select("*")
    .single<Contact>();
  if (upsertErr || !contact) {
    return NextResponse.json(
      { error: upsertErr?.message ?? "failed to upsert contact" },
      { status: 500 }
    );
  }

  // Place ONE call now, inline (no queue). testMode bypasses enroll-tag + call
  // window — this is an explicit on-demand trigger, not a cadence dial.
  try {
    const { callId, retellCallId } = await placeCall({
      agentId: agent.id,
      contactId: contact.id,
      toNumber: input.lead.phone,
      attemptNumber: (contact.attempt_count ?? 0) + 1,
      testMode: true,
    });
    return NextResponse.json({
      ok: true,
      callId,
      retellCallId,
      contactId: contact.id,
      leadId: input.lead.id,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "call failed to place" },
      { status: 502 }
    );
  }
}
