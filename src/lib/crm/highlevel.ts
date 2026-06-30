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
  CrmOpportunityCustomField,
  CrmPipeline,
  CrmUser,
  CreateTaskInput,
  HighLevelCredentials,
  HighLevelReauthFlagger,
  HighLevelTokenPersistor,
  LogCallInput,
  LogCallResult,
  MoveStageInput,
  OpportunityCustomFieldInput,
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

/**
 * Resolve the Call Conversation Provider used for playable call logs.
 *
 * HighLevel provider access is scoped to the installed sub-account/location. A
 * single global provider id works only while every connected location has that
 * provider installed; multi-tenant deployments need a per-location override.
 */
export function resolveHighLevelCallProviderId(
  locationId: string,
  credentialProviderId?: string | null
): string | null {
  const fromCreds = credentialProviderId?.trim();
  if (fromCreds) return fromCreds;

  const rawMap = process.env.HIGHLEVEL_CALL_PROVIDER_IDS?.trim();
  if (rawMap) {
    try {
      const parsed = JSON.parse(rawMap) as Record<string, unknown>;
      const mapped = parsed[locationId];
      if (typeof mapped === "string" && mapped.trim()) return mapped.trim();
    } catch {
      console.warn(
        "[highlevel] HIGHLEVEL_CALL_PROVIDER_IDS is not valid JSON; falling back to HIGHLEVEL_CALL_PROVIDER_ID"
      );
    }
  }

  return process.env.HIGHLEVEL_CALL_PROVIDER_ID?.trim() || null;
}

/** Build the customFields array for HighLevel opportunity create/update bodies. */
export function buildOpportunityCustomFieldsPayload(
  customFields?: OpportunityCustomFieldInput[]
): Array<{ id?: string; key?: string; field_value: string | string[] }> | undefined {
  if (!customFields?.length) return undefined;
  return customFields.map((cf) => ({
    ...(cf.id ? { id: cf.id } : {}),
    ...(cf.key ? { key: cf.key } : {}),
    field_value: cf.field_value,
  }));
}

/** Normalize a field key/name into a safe Retell dynamic-variable slug. */
function slugFieldName(raw: string): string {
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Coerce a HighLevel field value (string | array | object) to a trimmed string. */
function stringifyFieldValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map((v) => stringifyFieldValue(v)).filter(Boolean).join(", ");
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const inner = o.value ?? o.label ?? o.name;
    return inner != null ? String(inner).trim() : "";
  }
  return String(value).trim();
}

function isDropdownFieldType(dataType: string): boolean {
  const dt = dataType.toUpperCase();
  return (
    dt.includes("OPTION") ||
    dt === "DROPDOWN" ||
    dt === "SINGLE_OPTIONS" ||
    dt === "MULTIPLE_OPTIONS" ||
    dt === "RADIO" ||
    dt === "CHECKBOX" ||
    dt === "TEXTBOX_LIST" ||
    dt === "SELECT" ||
    dt === "PICKLIST"
  );
}

function fieldOptionSources(raw: Record<string, unknown>): unknown[] {
  const nested =
    raw.field && typeof raw.field === "object"
      ? (raw.field as Record<string, unknown>)
      : raw.customField && typeof raw.customField === "object"
        ? (raw.customField as Record<string, unknown>)
        : null;

  const candidates = [
    raw.picklistOptions,
    raw.options,
    raw.picklistImageOptions,
    raw.values,
    raw.optionLabels,
    nested?.picklistOptions,
    nested?.options,
    nested?.picklistImageOptions,
  ];

  for (const src of candidates) {
    if (Array.isArray(src) && src.length > 0) return src;
  }
  return [];
}

export function mapCustomFieldOptions(
  rawOptions: unknown[]
): { label: string; value: string }[] {
  const seen = new Set<string>();
  const out: { label: string; value: string }[] = [];

  for (const o of rawOptions) {
    let label: string;
    let value: string;

    if (typeof o === "string") {
      label = o.trim();
      value = label;
    } else if (o && typeof o === "object") {
      const obj = o as Record<string, unknown>;
      label = String(obj.label ?? obj.name ?? obj.text ?? obj.value ?? "").trim();
      if (!label) continue;
      // HighLevel SINGLE_OPTIONS writes expect the display label as field_value.
      value = String(obj.label ?? obj.name ?? obj.text ?? obj.value ?? label).trim();
    } else {
      label = String(o).trim();
      value = label;
    }

    if (!label) continue;
    const dedupeKey = `${value}::${label}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ label, value });
  }

  return out;
}

/** True when a raw HighLevel field definition has selectable options. */
export function isSelectableOpportunityField(raw: Record<string, unknown>): boolean {
  const dataType = String(raw.dataType ?? raw.type ?? "");
  if (isDropdownFieldType(dataType)) return true;
  return fieldOptionSources(raw).length > 0;
}

function unwrapCustomFieldRaw(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const nested = rec.customField ?? rec.field;
  if (nested && typeof nested === "object") {
    return nested as Record<string, unknown>;
  }
  return rec;
}

export function parseOpportunityCustomField(
  raw: Record<string, unknown>
): CrmOpportunityCustomField | null {
  const field = unwrapCustomFieldRaw(raw);
  if (!field?.id) return null;
  const options = mapCustomFieldOptions(fieldOptionSources(field));
  if (!isSelectableOpportunityField(field) && options.length === 0) return null;
  return {
    id: String(field.id),
    key: field.fieldKey ? String(field.fieldKey) : field.key ? String(field.key) : null,
    name: String(field.name ?? field.label ?? "Field"),
    dataType: String(field.dataType ?? field.type ?? "unknown"),
    options,
  };
}

function mergeOpportunityCustomField(
  byId: Map<string, CrmOpportunityCustomField>,
  parsed: CrmOpportunityCustomField | null
): void {
  if (!parsed) return;
  const existing = byId.get(parsed.id);
  if (!existing) {
    byId.set(parsed.id, parsed);
    return;
  }
  const options =
    parsed.options.length >= existing.options.length ? parsed.options : existing.options;
  byId.set(parsed.id, {
    ...existing,
    ...parsed,
    key: parsed.key ?? existing.key,
    name: parsed.name || existing.name,
    options,
  });
}

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
  private callProviderId?: string;
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
    this.callProviderId = creds.callProviderId;
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

  // Cache of this location's CONTACT custom-field definitions (id -> {key,name}),
  // so getContactFieldValues can map a contact's customFields[{id,value}] to
  // readable variable names. Cached per adapter instance (one call's lifetime).
  private contactFieldDefs: Map<string, { key: string | null; name: string }> | null =
    null;

  private async loadContactFieldDefs(): Promise<
    Map<string, { key: string | null; name: string }>
  > {
    if (this.contactFieldDefs) return this.contactFieldDefs;
    const defs = new Map<string, { key: string | null; name: string }>();
    for (const path of [
      `/locations/${this.locationId}/customFields?model=contact`,
      `/custom-fields/object/contact?locationId=${this.locationId}`,
    ]) {
      try {
        const data = await this.request<any>(path);
        const list: any[] = data.customFields ?? data.fields ?? [];
        for (const raw of list) {
          const f = unwrapCustomFieldRaw(raw);
          if (!f?.id) continue;
          defs.set(String(f.id), {
            key: f.fieldKey ? String(f.fieldKey) : f.key ? String(f.key) : null,
            name: String(f.name ?? f.label ?? ""),
          });
        }
        if (defs.size > 0) break;
      } catch {
        /* try next endpoint */
      }
    }
    this.contactFieldDefs = defs;
    return defs;
  }

  /**
   * Fetch a contact's field values (standard + custom) as a flat slug→string map
   * for Retell dynamic-variable injection. Each custom field is exposed under up
   * to two aliases — its fieldKey slug (e.g. `contact.houma_interested_program`
   * → `houma_interested_program`) and its name slug (e.g. "Baton Rouge Interested
   * Programs" → `baton_rouge_interested_programs`) — so the prompt resolves
   * regardless of which form is referenced. Best-effort: returns {} on failure.
   */
  async getContactFieldValues(contactId: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    let contact: any;
    try {
      const data = await this.request<any>(`/contacts/${contactId}`);
      contact = data.contact ?? data;
    } catch {
      return out;
    }
    if (!contact || typeof contact !== "object") return out;

    // Standard fields worth exposing to the prompt.
    const standard: Record<string, unknown> = {
      first_name: contact.firstName,
      last_name: contact.lastName,
      full_name:
        contact.contactName ??
        [contact.firstName, contact.lastName].filter(Boolean).join(" "),
      email: contact.email,
      phone: contact.phone,
      city: contact.city,
      state: contact.state,
      postal_code: contact.postalCode,
      company: contact.companyName,
    };
    for (const [k, v] of Object.entries(standard)) {
      const s = stringifyFieldValue(v);
      if (s) out[k] = s;
    }

    // Custom fields: contact.customFields = [{ id, value }]. Map id -> key/name.
    const cfs: any[] = Array.isArray(contact.customFields)
      ? contact.customFields
      : Array.isArray(contact.custom_fields)
        ? contact.custom_fields
        : [];
    if (cfs.length > 0) {
      const defs = await this.loadContactFieldDefs();
      for (const cf of cfs) {
        const id = cf?.id != null ? String(cf.id) : "";
        const value = stringifyFieldValue(cf?.value ?? cf?.field_value);
        if (!value) continue;
        const def = id ? defs.get(id) : undefined;
        const aliases = new Set<string>();
        if (def?.key) aliases.add(slugFieldName(def.key.replace(/^contact\./i, "")));
        if (def?.name) aliases.add(slugFieldName(def.name));
        // Fall back to the raw id-derived key if no definition matched.
        if (aliases.size === 0 && id) aliases.add(slugFieldName(id));
        for (const alias of aliases) {
          if (alias) out[alias] = value;
        }
      }
    }

    return out;
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
   * Two layers:
   *   1. A timeline NOTE with the AI summary + recording link (Notes tab).
   *   2. A PLAYABLE call entry in the Conversations/Call log, when a Call-type
   *      Conversation Provider is configured (HIGHLEVEL_CALL_PROVIDER_ID). This is
   *      the only way HighLevel renders a real call card with a recording player.
   *
   * Returns structured flags so callers can tell note-only vs playable call log.
   */
  async logCall(input: LogCallInput): Promise<LogCallResult> {
    const recording = input.recordingUrl?.trim();
    const warnings: string[] = [];

    const parts = [input.note ?? ""];
    if (recording) parts.push(`Recording: ${recording}`);
    await this.addNote(input.contactId, parts.filter(Boolean).join("\n\n"));

    const result: LogCallResult = {
      noteLogged: true,
      recordingCallLogged: false,
    };

    if (!recording) {
      return result;
    }

    const providerId = resolveHighLevelCallProviderId(this.locationId, this.callProviderId);
    if (!providerId) {
      warnings.push(
        `playableCall: no HighLevel Call Conversation Provider is configured for location ${this.locationId} — set callProviderId on the stored credentials, HIGHLEVEL_CALL_PROVIDER_IDS for this location, or HIGHLEVEL_CALL_PROVIDER_ID as a fallback`
      );
      result.warnings = warnings;
      return result;
    }

    try {
      await this.logPlayableCall(input, providerId, recording);
      result.recordingCallLogged = true;
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`playableCall: ${msg}`);
      console.error(
        `[highlevel] playable call log failed for contact ${input.contactId} ` +
          `(note still logged): ${msg}`
      );
      result.warnings = warnings;
      return result;
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
        ? p.stages
            .map((s: any) => ({
              id: String(s.id ?? s.stageId ?? s.pipelineStageId ?? ""),
              name: s.name ?? s.stageName ?? "Stage",
            }))
            .filter((s: { id: string }) => s.id)
        : [],
    }));
  }

  async listOpportunityCustomFields(): Promise<CrmOpportunityCustomField[]> {
    const byId = new Map<string, CrmOpportunityCustomField>();

    const ingest = (rawList: unknown[]) => {
      for (const item of rawList) {
        const raw = unwrapCustomFieldRaw(item);
        if (!raw) continue;
        mergeOpportunityCustomField(byId, parseOpportunityCustomField(raw));
      }
    };

    // Legacy list — often returns field metadata without picklist options populated.
    try {
      const data = await this.request<any>(
        `/locations/${this.locationId}/customFields?model=opportunity`
      );
      ingest(data.customFields ?? data.fields ?? []);
    } catch {
      /* fall through */
    }

    // V2 list — includes options for SINGLE_OPTIONS / dropdown fields.
    for (const path of [
      `/custom-fields/object/opportunity?locationId=${this.locationId}`,
      `/custom-fields/object-key/opportunity?locationId=${this.locationId}`,
    ]) {
      try {
        const v2 = await this.request<any>(path);
        ingest(v2.customFields ?? v2.fields ?? []);
      } catch {
        /* try next source */
      }
    }

    // Per-field detail when list endpoints omit options (common on legacy API).
    const needsOptions = Array.from(byId.values()).filter(
      (field) => field.options.length === 0 && isDropdownFieldType(field.dataType)
    );
    await Promise.all(
      needsOptions.map(async (field) => {
        const detail = await this.fetchOpportunityCustomFieldDetail(field.id);
        if (detail?.options.length) {
          mergeOpportunityCustomField(byId, detail);
        }
      })
    );

    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Fetch a single field definition when list responses omit dropdown options. */
  private async fetchOpportunityCustomFieldDetail(
    fieldId: string
  ): Promise<CrmOpportunityCustomField | null> {
    for (const path of [
      `/custom-fields/${fieldId}`,
      `/locations/${this.locationId}/customFields/${fieldId}?model=opportunity`,
    ]) {
      try {
        const data = await this.request<any>(path);
        const raw = unwrapCustomFieldRaw(data);
        if (raw) return parseOpportunityCustomField(raw);
      } catch {
        /* try next endpoint */
      }
    }
    return null;
  }

  async moveContactToStage(input: MoveStageInput): Promise<void> {
    const { contactId, pipelineId, stageId, contactName, status, customFields } = input;
    const customFieldsPayload = buildOpportunityCustomFieldsPayload(customFields);

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
          ...(customFieldsPayload ? { customFields: customFieldsPayload } : {}),
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
        ...(customFieldsPayload ? { customFields: customFieldsPayload } : {}),
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
