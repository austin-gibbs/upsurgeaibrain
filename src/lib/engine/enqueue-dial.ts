import type { CallJob } from "@/lib/queue/queues";
import { bullmqJobIdForPhone, dialPhonesForAttempt } from "./multi-phone";
import type { Agent, Contact, Workspace } from "@/types";

export function buildDialAttempt(params: {
  agent: Agent;
  workspace: Workspace;
  contact: Contact;
  agentId: string;
  baseJobId: string;
  queueDay: string;
  queueEntryId?: string;
  phoneIndex?: number;
  testMode?: boolean;
}): {
  attemptNumber: number;
  phoneNumbers: string[];
  phoneIndex: number;
  jobId: string;
  jobData: CallJob;
} | null {
  const phoneNumbers = dialPhonesForAttempt(params.agent, params.workspace, params.contact);
  if (!phoneNumbers.length) return null;

  const attemptNumber = params.contact.attempt_count + 1;
  const phoneIndex = params.phoneIndex ?? 0;
  const toNumber = phoneNumbers[phoneIndex];
  if (!toNumber) return null;

  return {
    attemptNumber,
    phoneNumbers,
    phoneIndex,
    jobId: bullmqJobIdForPhone(params.baseJobId, phoneIndex),
    jobData: {
      agentId: params.agentId,
      contactId: params.contact.id,
      toNumber,
      attemptNumber,
      phoneIndex,
      phoneCount: phoneNumbers.length,
      queueEntryId: params.queueEntryId,
      queueDay: params.queueDay,
      testMode: params.testMode,
    },
  };
}
