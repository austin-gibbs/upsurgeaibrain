// FUB-only multi-phone attempt helpers. HighLevel workspaces dial primary only.
import { effectiveCrmProvider } from "@/lib/agents/crm-inheritance";
import type { Agent, CallOutcome, Contact, Workspace } from "@/types";
import { TERMINAL_OUTCOMES } from "@/types";

/** Preserve dial order while dropping blanks and duplicate E.164 values. */
export function dedupePhones(phones: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of phones) {
    const phone = raw.trim();
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    out.push(phone);
  }
  return out;
}

/** Phones to try for one cadence attempt (all FUB numbers, primary-only otherwise). */
export function dialPhonesForAttempt(
  agent: Agent,
  workspace: Workspace,
  contact: Contact
): string[] {
  const phones = dedupePhones(contact.phones);
  if (!phones.length) return [];
  if (effectiveCrmProvider(agent, workspace) === "followupboss") return phones;
  return [phones[0]];
}

/** Deterministic BullMQ job id — chained phones append `:p{n}`. */
export function bullmqJobIdForPhone(baseJobId: string, phoneIndex: number): string {
  return phoneIndex === 0 ? baseJobId : `${baseJobId}:p${phoneIndex}`;
}

/** Chained phone job ids to remove when an attempt ends early. */
export function chainedPhoneJobIds(
  baseJobId: string,
  fromPhoneIndex: number,
  phoneCount: number
): string[] {
  const ids: string[] = [];
  for (let i = fromPhoneIndex + 1; i < phoneCount; i++) {
    ids.push(bullmqJobIdForPhone(baseJobId, i));
  }
  return ids;
}

export function shouldStopPhoneSequence(outcome: CallOutcome): boolean {
  if (TERMINAL_OUTCOMES.includes(outcome)) return true;
  return outcome === "interested_no_appointment" || outcome === "follow_up";
}

export function shouldContinueToNextPhone(
  outcome: CallOutcome,
  phoneIndex: number,
  phoneCount: number
): boolean {
  if (phoneIndex >= phoneCount - 1) return false;
  if (shouldStopPhoneSequence(outcome)) return false;
  return outcome === "no_answer_voicemail" || outcome === "error";
}

export function shouldFinalizeAttempt(
  outcome: CallOutcome,
  phoneIndex: number,
  phoneCount: number
): boolean {
  return !shouldContinueToNextPhone(outcome, phoneIndex, phoneCount);
}

export function resolveQueueDialTarget(params: {
  phoneNumbers: string[] | null | undefined;
  nextPhoneIndex: number;
  fallbackPhones: string[];
}): { toNumber: string; phoneIndex: number; phoneCount: number } | null {
  const snapshot =
    params.phoneNumbers && params.phoneNumbers.length > 0
      ? dedupePhones(params.phoneNumbers)
      : dedupePhones(params.fallbackPhones);
  if (!snapshot.length) return null;
  const phoneIndex = Math.min(
    Math.max(params.nextPhoneIndex, 0),
    snapshot.length - 1
  );
  return {
    toNumber: snapshot[phoneIndex],
    phoneIndex,
    phoneCount: snapshot.length,
  };
}
