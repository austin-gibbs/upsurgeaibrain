// =====================================================================
// HighLevel (GoHighLevel / LeadConnector) adapter — API v2.
//
// Auth: Bearer access token, scoped to a location (sub-account).
// HighLevel models tags as an array on the contact; tasks live under
// /contacts/{id}/tasks. Notes under /contacts/{id}/notes.
// Docs: https://highlevel.stoplight.io/docs/integrations
// =====================================================================
import type {
  CrmAdapter,
  CrmContact,
  CrmUser,
  CreateTaskInput,
  HighLevelCredentials,
  LogCallInput,
} from "./types";

const BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

export class HighLevelAdapter implements CrmAdapter {
  readonly provider = "highlevel" as const;
  private token: string;
  private locationId: string;

  constructor(creds: HighLevelCredentials) {
    this.token = creds.accessToken;
    this.locationId = creds.locationId;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Version: API_VERSION,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HighLevel ${init.method ?? "GET"} ${path} -> ${res.status}: ${body}`);
    }
    return (res.status === 204 ? (undefined as T) : ((await res.json()) as T));
  }

  private mapContact(c: any): CrmContact {
    const phones: string[] = [];
    if (c.phone) phones.push(String(c.phone));
    if (Array.isArray(c.additionalPhones)) {
      phones.push(...c.additionalPhones.map((p: any) => String(p.phone ?? p)));
    }
    return {
      id: String(c.id),
      fullName:
        c.contactName ?? [c.firstName, c.lastName].filter(Boolean).join(" ") ?? null,
      phones: phones.filter(Boolean),
      tags: Array.isArray(c.tags) ? c.tags.map(String) : [],
    };
  }

  async getContactsByTag(tag: string): Promise<CrmContact[]> {
    const out: CrmContact[] = [];
    let page = 1;
    const limit = 100;
    for (;;) {
      // The search endpoint accepts a tag filter via query string.
      const data = await this.request<any>(
        `/contacts/?locationId=${this.locationId}&limit=${limit}&page=${page}&query=&tags=${encodeURIComponent(tag)}`
      );
      const contacts: any[] = data.contacts ?? [];
      out.push(...contacts.map((c) => this.mapContact(c)));
      if (contacts.length < limit) break;
      page += 1;
    }
    return out;
  }

  async getContact(contactId: string): Promise<CrmContact | null> {
    try {
      const data = await this.request<any>(`/contacts/${contactId}`);
      return this.mapContact(data.contact ?? data);
    } catch {
      return null;
    }
  }

  async setTags(contactId: string, tags: string[]): Promise<void> {
    // HighLevel PUT /contacts/{id} accepts the full tags array.
    await this.request(`/contacts/${contactId}`, {
      method: "PUT",
      body: JSON.stringify({ tags }),
    });
  }

  async addNote(contactId: string, note: string): Promise<void> {
    await this.request(`/contacts/${contactId}/notes`, {
      method: "POST",
      body: JSON.stringify({ body: note }),
    });
  }

  // HighLevel has no FUB-style call activity with a recording play button.
  async logCall(input: LogCallInput): Promise<void> {
    const parts = [input.note ?? ""];
    if (input.recordingUrl) parts.push(`Recording: ${input.recordingUrl}`);
    await this.addNote(input.contactId, parts.filter(Boolean).join("\n\n"));
  }

  async createTask(input: CreateTaskInput): Promise<void> {
    await this.request(`/contacts/${input.contactId}/tasks`, {
      method: "POST",
      body: JSON.stringify({
        title: input.name,
        dueDate: input.dueAt,
        completed: false,
        ...(input.assigneeId ? { assignedTo: input.assigneeId } : {}),
      }),
    });
  }

  async listUsers(): Promise<CrmUser[]> {
    const data = await this.request<any>(`/users/?locationId=${this.locationId}`);
    const users: any[] = data.users ?? [];
    return users.map((u) => ({
      id: String(u.id),
      name: u.name ?? [u.firstName, u.lastName].filter(Boolean).join(" "),
      email: u.email,
    }));
  }

  async verifyCredentials(): Promise<boolean> {
    try {
      await this.request(`/locations/${this.locationId}`);
      return true;
    } catch {
      return false;
    }
  }
}
