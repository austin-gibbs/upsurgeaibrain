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
  CrmPipeline,
  CrmUser,
  CreateTaskInput,
  HighLevelCredentials,
  HighLevelTokenPersistor,
  LogCallInput,
  MoveStageInput,
} from "./types";
import { refreshHighLevelToken } from "./highlevel-oauth";

const BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

export class HighLevelAdapter implements CrmAdapter {
  readonly provider = "highlevel" as const;
  private token: string;
  private locationId: string;
  private refreshToken?: string;
  private expiresAt?: number;
  private onTokensRefreshed?: HighLevelTokenPersistor;
  /** De-dupes concurrent refreshes within one adapter instance. */
  private refreshing: Promise<void> | null = null;

  constructor(
    creds: HighLevelCredentials,
    onTokensRefreshed?: HighLevelTokenPersistor
  ) {
    this.token = creds.accessToken;
    this.locationId = creds.locationId;
    this.refreshToken = creds.refreshToken;
    this.expiresAt = creds.expiresAt;
    this.onTokensRefreshed = onTokensRefreshed;
  }

  /** Refresh the access token and persist the rotated pair. Idempotent under
   *  concurrency — callers share one in-flight refresh. */
  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error(
        "HighLevel access token expired and no refresh token is stored — reconnect the location via OAuth."
      );
    }
    if (this.refreshing) return this.refreshing;
    const refreshToken = this.refreshToken;
    this.refreshing = (async () => {
      const tokens = await refreshHighLevelToken(refreshToken, this.locationId);
      this.token = tokens.accessToken;
      this.refreshToken = tokens.refreshToken || this.refreshToken;
      this.expiresAt = tokens.expiresAt;
      if (this.onTokensRefreshed) {
        // Persistence is best-effort: the in-memory token is still valid for
        // this run even if the write-back fails.
        try {
          await this.onTokensRefreshed({
            accessToken: this.token,
            locationId: this.locationId,
            refreshToken: this.refreshToken,
            expiresAt: this.expiresAt,
          });
        } catch {
          /* non-fatal */
        }
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    retried = false
  ): Promise<T> {
    // Proactively refresh if we know the token is at/near expiry and we can.
    if (
      this.refreshToken &&
      typeof this.expiresAt === "number" &&
      Date.now() >= this.expiresAt
    ) {
      await this.refreshAccessToken();
    }

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

    // Reactive path: token rejected (expired/revoked early) — refresh once and retry.
    if (res.status === 401 && !retried && this.refreshToken) {
      await this.refreshAccessToken();
      return this.request<T>(path, init, true);
    }

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
      email: c.email ? String(c.email) : null,
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

  // ----- Pipeline routing (Opportunities API) -----

  async listPipelines(): Promise<CrmPipeline[]> {
    const data = await this.request<any>(
      `/opportunities/pipelines?locationId=${this.locationId}`
    );
    const pipelines: any[] = data.pipelines ?? [];
    return pipelines.map((p) => ({
      id: String(p.id),
      name: p.name ?? "Pipeline",
      stages: Array.isArray(p.stages)
        ? p.stages.map((s: any) => ({ id: String(s.id), name: s.name ?? "Stage" }))
        : [],
    }));
  }

  async moveContactToStage(input: MoveStageInput): Promise<void> {
    const { contactId, pipelineId, stageId, contactName, status } = input;

    // 1. Find an existing opportunity for this contact. Prefer one already in
    //    the target pipeline; otherwise reuse the first one we find so we move
    //    rather than spawn duplicates.
    let opportunityId: string | null = null;
    try {
      const search = await this.request<any>(
        `/opportunities/search?location_id=${this.locationId}&contact_id=${encodeURIComponent(
          contactId
        )}`
      );
      const opps: any[] = search.opportunities ?? [];
      const inPipeline = opps.find(
        (o) => String(o.pipelineId ?? o.pipeline_id ?? "") === pipelineId
      );
      const chosen = inPipeline ?? opps[0];
      if (chosen?.id) opportunityId = String(chosen.id);
    } catch {
      // Search failed (e.g. no opportunities) — fall through to create.
    }

    if (opportunityId) {
      await this.request(`/opportunities/${opportunityId}`, {
        method: "PUT",
        body: JSON.stringify({
          pipelineId,
          pipelineStageId: stageId,
          ...(status ? { status } : {}),
        }),
      });
      return;
    }

    // 2. No opportunity yet → create one directly in the target stage.
    await this.request(`/opportunities/`, {
      method: "POST",
      body: JSON.stringify({
        pipelineId,
        locationId: this.locationId,
        pipelineStageId: stageId,
        name: contactName || "UpSurge Lead",
        status: status ?? "open",
        contactId,
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
