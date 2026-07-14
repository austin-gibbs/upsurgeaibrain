// CRM writeback helpers — extracted for unit testing and shared logging.
import type { CrmAdapter } from "@/lib/crm/types";

export type FinalizedBy = "webhook" | "reconcile";

export interface CrmWriteFlags {
  noteLogged: boolean;
  recordingLogged: boolean;
  tagsSynced: boolean;
  crmErrors: string[];
}

export function formatCrmError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Append recording URL to a text note when logCall fails (FUB addNote fallback). */
export function noteWithRecording(
  note: string,
  recordingUrl: string | null | undefined
): string {
  if (!recordingUrl?.trim()) return note;
  return `${note}\n\nRecording: ${recordingUrl.trim()}`;
}

export function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

export function tagsMissingFromExisting(
  requestedTags: string[],
  existingTags: string[] = []
): string[] {
  const existing = new Set(dedupeTags(existingTags));
  return dedupeTags(requestedTags).filter((tag) => !existing.has(tag));
}

export async function addTagsToCrm(
  crm: CrmAdapter,
  contactId: string,
  tags: string[],
  existingTags: string[] = []
): Promise<string[]> {
  const addedTags = tagsMissingFromExisting(tags, existingTags);
  if (!addedTags.length) return [];

  if (crm.addTags) {
    await crm.addTags(contactId, addedTags);
  } else {
    await crm.setTags(contactId, dedupeTags([...existingTags, ...addedTags]));
  }
  return addedTags;
}

export interface LogCallToCrmInput {
  crm: CrmAdapter;
  contactId: string;
  phone: string;
  note: string;
  recordingUrl: string | null | undefined;
  durationSeconds: number | undefined;
  fromNumber: string | null | undefined;
  toNumber: string;
  /** Classified outcome — lets HighLevel render the right call status label. */
  outcome?: string;
  /** Whether the call reached voicemail. */
  inVoicemail?: boolean;
}

/** Primary logCall with addNote(+recording) fallback. Never throws. */
export async function logCallToCrm(input: LogCallToCrmInput): Promise<CrmWriteFlags> {
  const flags: CrmWriteFlags = {
    noteLogged: false,
    recordingLogged: false,
    tagsSynced: false,
    crmErrors: [],
  };

  const hasRecording = Boolean(input.recordingUrl?.trim());

  try {
    const result = await input.crm.logCall({
      contactId: input.contactId,
      phone: input.phone,
      isIncoming: false,
      note: input.note,
      outcome: input.outcome,
      inVoicemail: input.inVoicemail,
      durationSeconds: input.durationSeconds || undefined,
      fromNumber: input.fromNumber ?? undefined,
      toNumber: input.toNumber,
      recordingUrl: input.recordingUrl ?? undefined,
    });
    flags.noteLogged = result.noteLogged;
    // recording_logged means the native/playable call log path succeeded, not
    // merely that a recording URL was appended to a text note.
    flags.recordingLogged = hasRecording ? result.recordingCallLogged : false;
    if (result.warnings?.length) {
      flags.crmErrors.push(...result.warnings);
    }
    return flags;
  } catch (e) {
    const err = formatCrmError(e);
    flags.crmErrors.push(`logCall: ${err}`);
    console.error(`[crm-writeback] logCall failed for contact ${input.contactId}: ${err}`);
  }

  const fallbackNote = noteWithRecording(input.note, input.recordingUrl);
  try {
    await input.crm.addNote(input.contactId, fallbackNote);
    flags.noteLogged = true;
    // Fallback is note-only — never counts as a playable recording call log.
    flags.recordingLogged = false;
    if (hasRecording) {
      flags.crmErrors.push(
        "playableCall: primary logCall failed; only fallback note with recording link was written"
      );
    }
  } catch (e) {
    const err = formatCrmError(e);
    flags.crmErrors.push(`addNote: ${err}`);
    console.error(`[crm-writeback] addNote fallback failed for contact ${input.contactId}: ${err}`);
  }

  return flags;
}

export async function syncTagsToCrm(
  crm: CrmAdapter,
  contactId: string,
  tags: string[],
  flags: CrmWriteFlags,
  options: { existingTags?: string[] } = {}
): Promise<string[]> {
  try {
    await addTagsToCrm(
      crm,
      contactId,
      tags,
      options.existingTags
    );
    flags.tagsSynced = true;
    return dedupeTags(tags);
  } catch (e) {
    const err = formatCrmError(e);
    flags.crmErrors.push(`addTags: ${err}`);
    console.error(`[crm-writeback] addTags failed for contact ${contactId}: ${err}`);
    return tags;
  }
}

export async function createTasksToCrm(
  crm: CrmAdapter,
  contactId: string,
  tasks: Array<{
    name: string;
    type: string;
    dueAt: string;
    assigneeId: string | null;
  }>,
  flags: CrmWriteFlags
): Promise<boolean> {
  let anyCreated = false;
  for (const task of tasks) {
    try {
      await crm.createTask({
        contactId,
        name: task.name,
        type: task.type,
        dueAt: task.dueAt,
        assigneeId: task.assigneeId,
      });
      anyCreated = true;
    } catch (e) {
      const err = formatCrmError(e);
      flags.crmErrors.push(`createTask(${task.assigneeId ?? "unassigned"}): ${err}`);
      console.error(`[crm-writeback] createTask failed for contact ${contactId}: ${err}`);
    }
  }
  return anyCreated;
}

/** Summarize CRM errors for persistence on the call row. */
export function summarizeCrmErrors(errors: string[]): string | null {
  if (!errors.length) return null;
  return errors.join(" | ").slice(0, 2000);
}
