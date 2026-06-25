// =====================================================================
// GET  /api/workspaces/:id/queue-calls — list active queue entries
// POST /api/workspaces/:id/queue-calls — bulk enqueue selected contacts
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import { enqueueContactsNow } from "@/lib/engine/poller";
import { listActiveQueueEntries } from "@/lib/engine/call-queue";
import { queueCallsSchema } from "@/lib/validation";
import {
  contactHasEnrollTag,
  effectiveEnrollTag,
} from "@/lib/agents/enroll-tag";

export const runtime = "nodejs";
export const maxDuration = 60;

async function authorizeWorkspace(db: ReturnType<typeof createServerClient>, workspaceId: string) {
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };

  const { data: workspace, error } = await db
    .from("workspaces")
    .select("id, is_active, enroll_tag")
    .eq("id", workspaceId)
    .single<{ id: string; is_active: boolean; enroll_tag: string }>();
  if (error || !workspace) {
    return { error: NextResponse.json({ error: "not found" }, { status: 404 }) };
  }

  return { workspace, db };
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const db = createServerClient();
  const auth = await authorizeWorkspace(db, params.id);
  if ("error" in auth && auth.error) return auth.error;

  const agentId = req.nextUrl.searchParams.get("agentId");
  const rows = await listActiveQueueEntries(createServiceClient(), params.id);
  const filtered = agentId ? rows.filter((row) => row.agent_id === agentId) : rows;
  const entries = filtered.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agents?.name ?? "Agent",
    contactId: row.contact_id,
    contactName: row.contacts?.full_name ?? "Unknown contact",
    phone: row.contacts?.phones?.[0] ?? null,
    status: row.status,
    position: row.position,
    scheduledFor: row.scheduled_for,
    enqueuedAt: row.enqueued_at,
    startedAt: row.started_at,
    callId: row.call_id,
  }));

  return NextResponse.json({
    entries,
    summary: {
      total: entries.length,
      pending: entries.filter((e) => e.status === "pending").length,
      dialing: entries.filter((e) => e.status === "dialing").length,
    },
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const db = createServerClient();
  const auth = await authorizeWorkspace(db, params.id);
  if ("error" in auth && auth.error) return auth.error;
  const { workspace } = auth as {
    workspace: { id: string; is_active: boolean; enroll_tag: string };
  };

  if (!workspace.is_active) {
    return NextResponse.json({ error: "workspace inactive" }, { status: 400 });
  }

  const json = await req.json().catch(() => ({}));
  const parsed = queueCallsSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid payload", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const { agentId, contactIds } = parsed.data;

  const { data: agent } = await db
    .from("agents")
    .select("id, direction, enroll_tag")
    .eq("id", agentId)
    .eq("workspace_id", params.id)
    .single<{ id: string; direction: "inbound" | "outbound"; enroll_tag: string | null }>();
  if (!agent) {
    return NextResponse.json(
      { error: "agent not found in this workspace" },
      { status: 404 }
    );
  }
  if (agent.direction !== "outbound") {
    return NextResponse.json(
      { error: "only outbound agents can place calls" },
      { status: 400 }
    );
  }

  const enrollTag = effectiveEnrollTag(agent.enroll_tag, workspace.enroll_tag);
  const { data: contacts } = await db
    .from("contacts")
    .select("id, tags")
    .eq("workspace_id", params.id)
    .in("id", contactIds)
    .returns<{ id: string; tags: string[] }[]>();

  const eligibleIds: string[] = [];
  const enrollmentErrors: string[] = [];
  for (const contactId of contactIds) {
    const row = (contacts ?? []).find((c) => c.id === contactId);
    if (!row) {
      enrollmentErrors.push(`Contact ${contactId} not found in workspace`);
      continue;
    }
    if (!contactHasEnrollTag(row.tags, enrollTag)) {
      enrollmentErrors.push(
        `Contact is not enrolled with tag "${enrollTag}" for this agent`
      );
      continue;
    }
    eligibleIds.push(contactId);
  }

  if (eligibleIds.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        requested: contactIds.length,
        enqueued: 0,
        skippedReason: enrollmentErrors[0] ?? "No contacts belong to this agent's enrollment tag",
        errors: enrollmentErrors,
      },
      { status: 400 }
    );
  }

  const result = await enqueueContactsNow(agentId, eligibleIds);
  return NextResponse.json({
    ok: result.enqueued > 0,
    ...result,
    requested: contactIds.length,
    skippedEnrollment: contactIds.length - eligibleIds.length,
    errors: [...(result.errors ?? []), ...enrollmentErrors],
  });
}
