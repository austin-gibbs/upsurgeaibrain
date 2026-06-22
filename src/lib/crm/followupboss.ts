// =====================================================================
// Follow Up Boss adapter.
//
// Auth: HTTP Basic, username = API key, password empty.
// Notes from the production n8n build that are baked in here:
//   - Tasks: use `assignedUserId` (numeric). `assignedTo` (name) is REJECTED.
//   - Tags: PUT /people/{id} with the FULL tags array replaces them.
// Docs: https://docs.followupboss.com/reference
// =====================================================================
import type {
  CrmAdapter,
  CrmContact,
  CrmUser,
  CreateContactInput,
  CreateTaskInput,
  FubCredentials,
  LogCallInput,
} from "./types";

const BASE = "https://api.followupboss.com/v1";

/**
 * Coerce a CRM-stored phone into E.164 (the contract `CrmContact.phones`
 * documents and Retell's create-phone-call requires). Handles the common US
 * cases; already-E.164 (+...) values pass through untouched.
 */
function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("+")) return "+" + trimmed.slice(1).replace(/\D/g, "");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null; // unknown format — drop rather than dial something invalid
}

export class FollowUpBossAdapter implements CrmAdapter {
  readonly provider = "followupboss" as const;
  private authHeader: string;

  constructor(creds: FubCredentials) {
    this.authHeader =
      "Basic " + Buffer.from(`${creds.apiKey}:`).toString("base64");
  }

  private async request<T>(
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`FUB ${init.method ?? "GET"} ${path} -> ${res.status}: ${body}`);
    }
    return (res.status === 204 ? (undefined as T) : ((await res.json()) as T));
  }

  private mapContact(p: any): CrmContact {
    const phones: string[] = Array.isArray(p.phones)
      ? p.phones
          .map((x: any) => toE164(String(x.value)))
          .filter((v: string | null): v is string => Boolean(v))
      : [];
    return {
      id: String(p.id),
      fullName: p.name ?? [p.firstName, p.lastName].filter(Boolean).join(" ") ?? null,
      phones,
      tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
    };
  }

  async getContactsByTag(tag: string): Promise<CrmContact[]> {
    const out: CrmContact[] = [];
    let offset = 0;
    const limit = 100;
    // FUB paginates with limit/offset and returns _metadata.next.
    for (;;) {
      const data = await this.request<any>(
        `/people?tags=${encodeURIComponent(tag)}&limit=${limit}&offset=${offset}&sort=updated&direction=asc`
      );
      const people: any[] = data.people ?? [];
      out.push(...people.map((p) => this.mapContact(p)));
      if (people.length < limit) break;
      offset += limit;
    }
    return out;
  }

  async getContact(contactId: string): Promise<CrmContact | null> {
    try {
      const p = await this.request<any>(`/people/${contactId}`);
      return this.mapContact(p);
    } catch {
      return null;
    }
  }

  async findContactByPhone(phone: string): Promise<CrmContact | null> {
    const e164 = toE164(phone) ?? phone;
    try {
      // FUB matches people by phone via the `phone` query param.
      const data = await this.request<any>(
        `/people?phone=${encodeURIComponent(e164)}&limit=1`
      );
      const people: any[] = data.people ?? [];
      return people.length ? this.mapContact(people[0]) : null;
    } catch {
      return null;
    }
  }

  async createContact(input: CreateContactInput): Promise<CrmContact> {
    const parts = (input.fullName ?? "").trim().split(/\s+/).filter(Boolean);
    const firstName = parts[0] ?? "Inbound";
    const lastName = parts.slice(1).join(" ") || "Caller";
    const e164 = input.phone ? toE164(input.phone) ?? input.phone : null;

    const body: Record<string, unknown> = {
      firstName,
      lastName,
      // FUB requires a source; this is how the lead shows its origin.
      source: input.source ?? "AI Inbound Call",
    };
    if (e164) body.phones = [{ value: e164, type: "Mobile" }];
    if (input.email) body.emails = [{ value: input.email, type: "Work" }];
    if (input.tags?.length) body.tags = input.tags;
    if (input.assignedUserId) body.assignedUserId = Number(input.assignedUserId);

    const created = await this.request<any>(`/people`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return this.mapContact(created);
  }

  async assignContact(contactId: string, userId: string): Promise<void> {
    await this.request(`/people/${contactId}`, {
      method: "PUT",
      body: JSON.stringify({ assignedUserId: Number(userId) }),
    });
  }

  async setTags(contactId: string, tags: string[]): Promise<void> {
    await this.request(`/people/${contactId}`, {
      method: "PUT",
      body: JSON.stringify({ tags }),
    });
  }

  async addNote(contactId: string, note: string): Promise<void> {
    await this.request(`/notes`, {
      method: "POST",
      body: JSON.stringify({ personId: Number(contactId), body: note }),
    });
  }

  async logCall(input: LogCallInput): Promise<void> {
    const body: Record<string, unknown> = {
      personId: Number(input.contactId),
      phone: input.phone,
      isIncoming: input.isIncoming ?? false,
    };
    if (input.note) body.note = input.note;
    if (input.outcome) body.outcome = input.outcome;
    if (typeof input.durationSeconds === "number") body.duration = input.durationSeconds;
    if (input.fromNumber) body.fromNumber = input.fromNumber;
    if (input.toNumber) body.toNumber = input.toNumber;
    if (input.recordingUrl) body.recordingUrl = input.recordingUrl;
    await this.request(`/calls`, { method: "POST", body: JSON.stringify(body) });
  }

  async createTask(input: CreateTaskInput): Promise<void> {
    const body: Record<string, unknown> = {
      personId: Number(input.contactId),
      name: input.name,
      type: input.type,
      dueDate: input.dueAt.slice(0, 10),
      dueDateTime: input.dueAt,
    };
    // Critical: FUB wants the numeric user id, not a name string.
    if (input.assigneeId) body.assignedUserId = Number(input.assigneeId);
    await this.request(`/tasks`, { method: "POST", body: JSON.stringify(body) });
  }

  async listUsers(): Promise<CrmUser[]> {
    const data = await this.request<any>(`/users?limit=100`);
    const users: any[] = data.users ?? [];
    return users.map((u) => ({
      id: String(u.id),
      name: u.name ?? [u.firstName, u.lastName].filter(Boolean).join(" "),
      email: u.email,
    }));
  }

  async verifyCredentials(): Promise<boolean> {
    try {
      await this.request(`/me`);
      return true;
    } catch {
      return false;
    }
  }
}
