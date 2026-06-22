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
  durationSeconds?: number;
  fromNumber?: string;
  toNumber?: string;
  recordingUrl?: string;
}

export interface CrmUser {
  id: string;
  name: string;
  email?: string;
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
  logCall(input: LogCallInput): Promise<void>;

  createTask(input: CreateTaskInput): Promise<void>;

  /** Users who can be assigned tasks — powers the wizard assignee picker. */
  listUsers(): Promise<CrmUser[]>;

  /** Cheap call to validate stored credentials. Returns true if usable. */
  verifyCredentials(): Promise<boolean>;

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
}
