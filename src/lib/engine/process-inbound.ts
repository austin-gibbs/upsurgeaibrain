// =====================================================================
// Inbound processor — the Call Concierge ("Mia inbound") handler.
//
// Triggered by the Retell `call_analyzed` webhook for an INBOUND call to
// the business line. Unlike the outbound path (process-outcome.ts), there
// is no pre-created `calls` row and the caller is usually not in our DB.
// For one answered call we:
//   1. resolve the agent + workspace from the inbound Retell agent id
//   2. resolve or create the caller in Follow Up Boss (matched by phone)
//   3. log the call (recording + duration) and write a note in the exact
//      Email Summary format the concierge prompt defines
//   4. tag priority/type, assign the lead, and create a "Follow up with
//      {caller}" task for each of the configured follow-up users
//   5. store an idempotent inbound `calls` row (keyed on retell_call_id)
//
// Email delivery is intentionally handled by Follow Up Boss's own
// assignment notifications — assigning + tasking Nil and Jori is what
// surfaces the summary to the team (no separate mailer).
// =====================================================================
import { createServiceClient } from "@/lib/supabase/server";
import { getCrmAdapterForAgent } from "@/lib/crm";
import { extractFromRetellPayload } from "./outcome";
import { todayInTz } from "./cadence";
import { addTagsToCrm } from "./crm-writeback";
import { pickAssigneeForLine, resolveLineRep } from "./inbound-routing";
import type { Agent, Workspace } from "@/types";
import type { Database } from "@/types/database";

type CallInsert = Database["public"]["Tables"]["calls"]["Insert"];
type CallUpdate = Database["public"]["Tables"]["calls"]["Update"];

/**
 * Fallback CRM users (by name, case-insensitive substring) assigned the lead
 * and tasked to follow up when the dialed line ISN'T mapped to a specific rep
 * in inbound-routing.ts. When the dialed number IS mapped (the normal Nil
 * Patel Realty case), the single owning rep is used instead — see
 * `pickAssigneeForLine`. The first match is set as the lead's assigned owner;
 * all matches get a follow-up task.
 */
const FOLLOW_UP_USER_NAMES = ["Nil", "Jori"];

/** Minutes from now for the auto-created follow-up task due time. */
const FOLLOW_UP_DUE_MINUTES = 30;

export async function processInboundCall(
  body: any
): Promise<{ ok: boolean; reason?: string }> {
  const supabase = createServiceClient();
  const call = body?.call ?? body ?? {};
  const callId = String(call.call_id ?? "");
  if (!callId) return { ok: false, reason: "no call_id in inbound payload" };

  // Idempotency: the partial unique index on calls(retell_call_id) backs this.
  const { data: existing } = await supabase
    .from("calls")
    .select("id,status")
    .eq("retell_call_id", callId)
    .maybeSingle<{ id: string; status: string }>();
  if (existing?.status === "completed") {
    return { ok: true, reason: "already processed" };
  }

  const base = extractFromRetellPayload(body);
  const custom: Record<string, any> = call.call_analysis?.custom_analysis_data ?? {};
  const retellAgentId = String(call.agent_id ?? "");
  const fromNumber: string | null = call.from_number ?? base.fromNumber ?? null;
  const toNumber: string | null = call.to_number ?? null;

  // 1. Resolve the agent + workspace from the inbound Retell agent id.
  const { data: agent } = await supabase
    .from("agents")
    .select("*")
    .eq("retell_agent_id", retellAgentId)
    .maybeSingle<Agent>();
  if (!agent) {
    return { ok: false, reason: `no agent for retell_agent_id ${retellAgentId}` };
  }
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("*")
    .eq("id", agent.workspace_id)
    .single<Workspace>();
  if (!workspace) return { ok: false, reason: "workspace not found" };

  const crm = getCrmAdapterForAgent(agent, workspace);
  if (!crm.findContactByPhone || !crm.createContact) {
    return { ok: false, reason: "CRM adapter lacks inbound contact resolution" };
  }

  const callerName = str(custom.caller_full_name) || null;
  const callerEmail = str(custom.caller_email) || null;
  const callbackPhone = str(custom.caller_phone) || fromNumber;
  const priority = (str(custom.priority_level) || "NORMAL").toUpperCase();
  const callType = str(custom.call_type) || "General";
  const today = todayInTz(workspace.timezone);

  // 2. Resolve or create the caller in the CRM, matched by phone.
  let contact = fromNumber ? await crm.findContactByPhone(fromNumber) : null;
  if (!contact) {
    contact = await crm.createContact({
      fullName: callerName,
      phone: callbackPhone,
      email: callerEmail,
      tags: ["AI Inbound Call"],
      source: "AI Inbound Call (Mia)",
    });
  }

  // 3. Build the note in the concierge's Email Summary format and log the call.
  const noteBody = formatInboundNote({
    custom,
    callerName,
    callbackPhone,
    callerEmail,
    fromNumber,
    summary: base.summary,
    today,
    priority,
    callType,
  });

  try {
    await crm.logCall({
      contactId: contact.id,
      phone: callbackPhone ?? fromNumber ?? "",
      isIncoming: true,
      note: noteBody,
      durationSeconds: base.durationSeconds || undefined,
      fromNumber: fromNumber ?? undefined,
      toNumber: toNumber ?? undefined,
      recordingUrl: base.recordingUrl ?? undefined,
    });
  } catch {
    // If the call-log endpoint rejects, at least preserve the summary as a note.
    try {
      await crm.addNote(contact.id, noteBody);
    } catch {
      /* non-fatal */
    }
  }

  // 4. Tag priority + type (preserve existing tags).
  try {
    const tags = Array.from(
      new Set([
        ...(contact.tags ?? []),
        "AI Inbound Call",
        `Priority: ${priority}`,
        `Call Type: ${callType}`,
      ])
    );
    await addTagsToCrm(crm, contact.id, tags, contact.tags ?? []);
  } catch {
    /* non-fatal */
  }

  // Assign the lead + create a follow-up task. Route by the DIALED line:
  // each rep owns a dedicated inbound number, so the number the caller dialed
  // (`toNumber`) determines who owns the lead. When that line is mapped, we
  // assign + task ONLY that rep. When it isn't (an unmapped line / other
  // workspace), fall back to the default follow-up users.
  try {
    const users = await crm.listUsers();
    const lineAssignee = pickAssigneeForLine(toNumber, users);
    const matched = lineAssignee
      ? [lineAssignee]
      : FOLLOW_UP_USER_NAMES.map((n) =>
          users.find((u) => u.name?.toLowerCase().includes(n.toLowerCase()))
        ).filter((u): u is NonNullable<typeof u> => Boolean(u));

    // Surface an operational signal when a rep's line was dialed but their CRM
    // user couldn't be resolved — the task would otherwise silently fall back.
    const expectedRep = resolveLineRep(toNumber);
    if (expectedRep && !lineAssignee) {
      console.error(
        `[process-inbound] dialed line ${toNumber} maps to "${expectedRep.repName}" ` +
          `but no matching CRM user was found — falling back to ${FOLLOW_UP_USER_NAMES.join("/")}.`
      );
    }

    if (matched[0] && crm.assignContact) {
      try {
        await crm.assignContact(contact.id, matched[0].id);
      } catch {
        /* non-fatal */
      }
    }

    // Task title uses the lead's full name — prefer the resolved/created CRM
    // contact name, fall back to the name Mia gathered on the call.
    const leadName = contact.fullName || callerName || "Inbound Caller";
    const dueAt = new Date(Date.now() + FOLLOW_UP_DUE_MINUTES * 60_000).toISOString();
    for (const u of matched) {
      try {
        await crm.createTask({
          contactId: contact.id,
          name: `New Lead | ${leadName}`,
          type: "Follow Up",
          dueAt,
          assigneeId: u.id,
        });
      } catch {
        /* non-fatal */
      }
    }
  } catch {
    /* non-fatal */
  }

  // 5. Persist an idempotent inbound call record (contact-less is allowed).
  const row: CallInsert = {
    workspace_id: workspace.id,
    agent_id: agent.id,
    contact_id: null,
    direction: "inbound",
    attempt_number: 0,
    to_number: toNumber ?? "",
    retell_call_id: callId,
    status: "completed" as const,
    summary: base.summary,
    transcript: base.transcript,
    raw_payload: body,
    completed_at: new Date().toISOString(),
    crm_contact_id: contact.id,
    contact_name: contact.fullName ?? callerName,
    contact_email: contact.email ?? callerEmail,
  };
  if (existing) {
    const update: CallUpdate = row;
    await supabase.from("calls").update(update).eq("id", existing.id);
  } else {
    await supabase.from("calls").insert(row);
  }

  return { ok: true };
}

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

/**
 * Render the concierge's Email Summary format as a CRM note body. This is the
 * same structure the prompt defines — delivered to the team via FUB's
 * assignment notification rather than a separate email.
 */
function formatInboundNote(p: {
  custom: Record<string, any>;
  callerName: string | null;
  callbackPhone: string | null;
  callerEmail: string | null;
  fromNumber: string | null;
  summary: string | null;
  today: string;
  priority: string;
  callType: string;
}): string {
  const c = p.custom;
  const line = (label: string, val: unknown) => `${label}: ${str(val)}`;
  return [
    `NEW CALL - ${p.priority} - ${p.callerName ?? "Unknown"} - ${p.callType}`,
    "",
    line("Caller Name", p.callerName),
    line("Phone", p.callbackPhone ?? p.fromNumber),
    line("Email", p.callerEmail),
    line("Call Type", p.callType),
    line("Property Address", c.property_address),
    line("Reason For Call", c.reason_for_call ?? p.summary),
    line("Timeline", c.timeline),
    line("Motivation", c.motivation),
    line("Key Details", c.key_details),
    line("Requested Follow-Up", c.requested_follow_up),
    `Priority Level: ${p.priority}`,
    line("Date & Time of Call", p.today),
    line("Mia's Notes", c.mia_notes ?? p.summary),
  ].join("\n");
}
