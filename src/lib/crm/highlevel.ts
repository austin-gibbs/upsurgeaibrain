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
  HighLevelReauthFlagger,
  HighLevelTokenPersistor,
  LogCallInput,
  MoveStageInput,
} from "./types";
import {
  refreshHighLevelToken,
  HighLevelReauthRequiredError,
  type HighLevelTokens,
} from "./highlevel-oauth";
import { fetchWithTimeout, parseJsonResponse, retryAfterMs, sleep } from "@/lib/http";

const BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";
// The Conversations endpoints (search/create conversation, log external call)
// are versioned separately from contacts/opportunities and reject 2021-07-28.
const CONVERSATIONS_API_VERSION = "2021-04-15";
const MAX_429_RETRIES = 2;

// Map our internal outcome → a HighLevel call status so the logged call card
// reads correctly (Answered / Voicemail / No-answer, etc). Defaults to
// "completed" for connected conversations.
function mapCallStatus(input: LogCallInput): string {
  if (input.inVoicemail) return "voicemail";
  switch (input.outcome) {
    case "no_answer_voicemail":
      return "voicemail";
    case "no_answer":
      return "no-answer";
    case "failed":
      return "failed";
    default:
      return "completed";
  }
}

// Cross-instance refresh serialization. A NEW adapter is constructed per job
// (getCrmAdapterForAgent), so per-instance dedupe is not enough: under worker
// concurrency many jobs for the same location would refresh simultaneously,
// and HighLevel ROTATES the refresh token — the first refresh invalidates the
// token the others are about to use, silently de-authing the location. Keyed by
// locationId, this shares one in-flight refresh across every adapter instance
// in the process.
const refreshLocks = new Map<string, Promise<HighLevelTokens>>();

export class HighLevelAdapter implements CrmAdapter {
  readonly provider = "highlevel" as const;
  private token: string;
  private locationId: string;
  private refreshToken?: string;
  private expiresAt?: number;
  private onTokensRefreshed?: HighLevelTokenPersistor;
  private onReauthRequired?: HighLevelReauthFlagger;

  constructor(
    creds: HighLevelCredentials,
    onTokensRefreshed?: HighLevelTokenPersistor,
    onReauthRequired?: HighLevelReauthFlagger
  ) {
    this.token = creds.accessToken;
    this.locationId = creds.locationId;
    this.refreshToken = creds.refreshToken;
    this.expiresAt = creds.expiresAt;
    this.onTokensRefreshed = onTokensRefreshed;
    this.onReauthRequired = onReauthRequired;
  }

  /** Refresh the access token and persist the rotated pair. Serialized across
   *  ALL adapter instances in the process via a locationId-keyed lock, so the
   *  rotating refresh token is never used concurrently (which would de-auth). */
  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error(
        "HighLevel access token expired and no refresh token is stored — reconnect the location via OAuth."
      );
    }

    // If another adapter instance is already refreshing this location, await it
    // and adopt its result rather than firing a second (token-invalidating) call.
    const inflight = refreshLocks.get(this.locationId);
    if (inflight) {
      this.adoptTokens(await this.awaitRefresh(inflight));
      return;
    }

    const refreshToken = this.refreshToken;
    const locationId = this.locationId;
    const promise = refreshHighLevelToken(refreshToken, locationId).finally(() => {
      refreshLocks.delete(locationId);
    });
    refreshLocks.set(locationId, promise);

    const tokens = await this.awaitRefresh(promise);
    this.adoptTokens(tokens);

    if (this.onTokensRefreshed) {
      // Persistence is best-effort: the in-memory token is still valid for this
      // run even if the write-back fails.
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
  }

  private adoptTokens(tokens: HighLevelTokens): void {
    this.token = tokens.accessToken;
    this.refreshToken = tokens.refreshToken || this.refreshToken;
    this.expiresAt = tokens.expiresAt;
  }

  /** Await a refresh and, if the refresh token is dead, fire the reauth flag
   *  (best-effort) before rethrowing so the caller can stop retrying blindly. */
  private async awaitRefresh(p: Promise<HighLevelTokens>): Promise<HighLevelTokens> {
    try {
      return await p;
    } catch (e) {
      if (e instanceof HighLevelReauthRequiredError && this.onReauthRequired) {
        try {
          await this.onReauthRequired(e.message);
        } catch {
          /* best-effort */
        }
      }
      throw e;
    }
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

    let res = await fetchWithTimeout(`${BASE}${path}`, {
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

    // Honor rate limiting with a bounded Retry-After wait, then retry once.
    if (res.status === 429 && !retried) {
      await sleep(retryAfterMs(res.headers.get("retry-after")));
      res = await fetchWithTimeout(`${BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Version: API_VERSION,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(init.headers ?? {}),
        },
      });
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HighLevel ${init.method ?? "GET"} ${path} -> ${res.status}: ${body}`);
    }
    return parseJsonResponse<T>(res, `HighLevel ${init.method ?? "GET"} ${path}`);
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
    const pageLimit = 100;
    for (;;) {
      // GET /contacts does not accept a tags query param (422). Use the advanced
      // search endpoint with a tag filter instead.
      const data = await this.request<any>("/contacts/search", {
        method: "POST",
        body: JSON.stringify({
          locationId: this.locationId,
          page,
          pageLimit,
          filters: [{ field: "tags", operator: "eq", value: tag }],
        }),
      });
      const contacts: any[] = data.contacts ?? [];
      out.push(...contacts.map((c) => this.mapContact(c)));
      if (contacts.length < pageLimit) break;
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

  /**
   * Log a completed call to HighLevel.
   *
   * Two layers, both best-effort but the NOTE is guaranteed (it's the back-compat
   * path that has always worked):
   *   1. A timeline NOTE with the AI summary + recording link (Notes tab).
   *   2. A PLAYABLE call entry in the Conversations/Call log, when a Call-type
   *      Conversation Provider is configured (HIGHLEVEL_CALL_PROVIDER_ID). This is
   *      the only way HighLevel renders a real call card with a recording player.
   *
   * The playable step is wrapped so it can never fail the call log: the note
   * already carries the recording link, and throwing here would make the caller
   * (logCallToCrm) write a duplicate fallback note.
   */
  async logCall(input: LogCallInput): Promise<void> {
    const recording = input.recordingUrl?.trim();

    const parts = [input.note ?? ""];
    if (recording) parts.push(`Recording: ${recording}`);
    await this.addNote(input.contactId, parts.filter(Boolean).join("\n\n"));

    const providerId = process.env.HIGHLEVEL_CALL_PROVIDER_ID?.trim();
    if (!providerId) return; // note-only mode (no Call conversation provider yet)

    try {
      await this.logPlayableCall(input, providerId, recording);
    } catch (e) {
      console.error(
        `[highlevel] playable call log failed for contact ${input.contactId} ` +
          `(note still logged): ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /** Create the playable Call entry in the contact's conversation. */
  private async logPlayableCall(
    input: LogCallInput,
    providerId: string,
    recording: string | undefined
  ): Promise<void> {
    const conversationId = await this.getOrCreateConversationId(input.contactId);
    await this.request(
      `/conversations/messages/outbound`,
      {
        method: "POST",
        headers: { Version: CONVERSATIONS_API_VERSION },
        body: JSON.stringify({
          type: "Call",
          conversationId,
          conversationProviderId: providerId,
          date: new Date().toISOString(),
          call: {
            to: input.toNumber ?? input.phone,
            from: input.fromNumber ?? "",
            status: mapCallStatus(input),
          },
          // The recording URL is accepted as an attachment when LOGGING a call
          // (it renders the play button); reads later use the recording endpoint.
          ...(recording ? { attachments: [recording] } : {}),
        }),
      }
    );
  }

  /** Find the contact's conversation, creating one if none exists. */
  private async getOrCreateConversationId(contactId: string): Promise<string> {
    const search = await this.request<any>(
      `/conversations/search?locationId=${this.locationId}&contactId=${encodeURIComponent(
        contactId
      )}`,
      { headers: { Version: CONVERSATIONS_API_VERSION } }
    );
    const existing = (search?.conversations ?? [])[0];
    if (existing?.id) return String(existing.id);

    const created = await this.request<any>(`/conversations/`, {
      method: "POST",
      headers: { Version: CONVERSATIONS_API_VERSION },
      body: JSON.stringify({ locationId: this.locationId, contactId }),
    });
    const id = created?.conversation?.id ?? created?.id;
    if (!id) throw new Error("HighLevel returned no conversation id");
    return String(id);
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
