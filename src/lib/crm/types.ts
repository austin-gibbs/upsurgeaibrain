// =====================================================================
// CRM adapter interface.
//
// Every CRM (Follow Up Boss, HighLevel, and any future provider) is hidden
// behind this single interface. The call engine is 100% CRM-agnostic: it
// only ever talks to a `CrmAdapter`. Add a new CRM by implementing this
// interface and registering it in ./index.ts — nothing else changes.
// =====================================================================
import type { CrmProvider } from "@/types";

export interface CrmContact {
  /** Provider's native id. */
  id: string;
  fullName: string | null;
  email: string | null;
  /** E.164 phone numbers in preferred dial order. */
  phones: string[];
  tags: string[];
}

export interface CreateTaskInput {
  contactId: string;
  name: string;
  type: string;
  /** ISO 8601. */
  dueAt: string;
  /** Provider-native assignee id (FUB numeric id / HighLevel user id). */
  assigneeId?: string | null;
}

export interface LogCallInput {
  contactId: string;
  phone: string;
  isIncoming?: boolean;
  note?: string;
  outcome?: string;
  /** True when the call reached voicemail — drives the CRM call status label. */
  inVoicemail?: boolean;
  durationSeconds?: number;
  fromNumber?: string;
  toNumber?: string;
  recordingUrl?: string;
}

/** Structured outcome from logCall — lets callers distinguish note vs playable recording. */
export interface LogCallResult {
  /** Timeline note or call-summary text landed in the CRM. */
  noteLogged: boolean;
  /**
   * Native/playable call log with recording was created (FUB /calls, HL Conversations
   * Call message). False when only a text note with a recording URL was written.
   */
  recordingCallLogged: boolean;
  /** Non-fatal issues (e.g. HL note ok but playable call path failed). */
  warnings?: string[];
}

export interface CrmUser {
  id: string;
  name: string;
  email?: string;
}

export interface CrmPipelineStage {
  id: string;
  name: string;
}

export interface CrmPipeline {
  id: string;
  name: string;
  stages: CrmPipelineStage[];
}

export interface CrmOpportunityCustomFieldOption {
  label: string;
  value: string;
}

/** A dropdown/select custom field on HighLevel opportunities. */
export interface CrmOpportunityCustomField {
  id: string;
  key: string | null;
  name: string;
  dataType: string;
  options: CrmOpportunityCustomFieldOption[];
}

export interface OpportunityCustomFieldInput {
  id?: string;
  key?: string;
  field_value: string | string[];
}

export interface MoveStageInput {
  /** Provider-native contact id. */
  contactId: string;
  pipelineId: string;
  stageId: string;
  /** Used to name a newly-created opportunity when the contact has none. */
  contactName?: string | null;
  /** Optional opportunity status to set alongside the stage move. */
  status?: "open" | "won" | "lost" | "abandoned";
  /** Optional opportunity custom fields to set on create/update. */
  customFields?: OpportunityCustomFieldInput[];
}

export interface CreateContactInput {
  fullName: string | null;
  /** E.164 preferred. */
  phone?: string | null;
  email?: string | null;
  tags?: string[];
  /** Lead source label (FUB "source"). */
  source?: string;
  /** Provider-native user id to assign the new lead to. */
  assignedUserId?: string | null;
}

export interface CrmAdapter {
  readonly provider: CrmProvider;

  /** Contacts currently carrying the enrollment tag. */
  getContactsByTag(tag: string): Promise<CrmContact[]>;

  getContact(contactId: string): Promise<CrmContact | null>;

  /** Replace the full tag set on a contact (PUT semantics). */
  setTags(contactId: string, tags: string[]): Promise<void>;

  /** Append a timeline note / activity. */
  addNote(contactId: string, note: string): Promise<void>;

  /** Log a completed call (with recording) to the CRM timeline. */
  logCall(input: LogCallInput): Promise<LogCallResult>;

  createTask(input: CreateTaskInput): Promise<void>;

  /** Users who can be assigned tasks — powers the wizard assignee picker. */
  listUsers(): Promise<CrmUser[]>;

  /** Cheap call to validate stored credentials. Returns true if usable. */
  verifyCredentials(): Promise<boolean>;

  // ----- Pipeline routing (optional; HighLevel implements these) -----

  /** List the pipelines + their stages, to populate the mapping UI. */
  listPipelines?(): Promise<CrmPipeline[]>;

  /** List dropdown custom fields on opportunities (HighLevel only). */
  listOpportunityCustomFields?(): Promise<CrmOpportunityCustomField[]>;

  /**
   * Move the contact's opportunity to a pipeline stage. Finds the contact's
   * existing opportunity (preferring one already in the target pipeline) and
   * updates its stage; creates a new opportunity in that stage if none exists.
   */
  moveContactToStage?(input: MoveStageInput): Promise<void>;

  // ----- Inbound concierge support (optional; FUB implements these) -----

  /** Find an existing contact by phone number (E.164). Inbound caller match. */
  findContactByPhone?(phone: string): Promise<CrmContact | null>;

  /** Create a new contact and return it. Used when an inbound caller is new. */
  createContact?(input: CreateContactInput): Promise<CrmContact>;

  /** Set the assigned user (owner) of a contact. */
  assignContact?(contactId: string, userId: string): Promise<void>;
}

/** Shape of decrypted credentials per provider. */
export interface FubCredentials {
  apiKey: string;
}
export interface HighLevelCredentials {
  accessToken: string;
  locationId: string;
  /** OAuth refresh token. Present when connected via OAuth; absent for a
   *  legacy hand-pasted static token (which then can't be auto-refreshed). */
  refreshToken?: string;
  /** Epoch milliseconds when the access token expires. */
  expiresAt?: number;
}

/** Called by the adapter after it rotates its tokens, so the caller can
 *  persist the new encrypted credentials back to the agent/workspace row. */
export type HighLevelTokenPersistor = (
  creds: HighLevelCredentials
) => Promise<void>;

/** Called when the refresh token is dead (invalid_grant) so the caller can flag
 *  the connection as needing re-authorization in the UI. Best-effort. */
export type HighLevelReauthFlagger = (detail: string) => Promise<void>;
