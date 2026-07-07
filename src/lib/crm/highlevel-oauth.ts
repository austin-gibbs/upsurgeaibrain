// =====================================================================
// HighLevel (LeadConnector) OAuth 2.0 helpers.
//
// HighLevel access tokens are short-lived (expires_in, typically 24h) and
// MUST be refreshed with the long-lived refresh token. Both the initial
// authorization-code exchange and the refresh hit the same token endpoint.
//
// App-level client credentials come from the HighLevel Marketplace app:
//   HIGHLEVEL_CLIENT_ID / HIGHLEVEL_CLIENT_SECRET   (server-only)
// Docs: https://highlevel.stoplight.io/docs/integrations (OAuth 2.0)
// =====================================================================
import { fetchWithTimeout } from "@/lib/http";

const TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
const AUTHORIZE_URL = "https://marketplace.gohighlevel.com/oauth/chooselocation";

/**
 * Thrown when HighLevel rejects the refresh token (revoked/expired/rotated out
 * from under us). Distinct type so callers can flag the agent for reconnect
 * instead of blindly retrying a grant that will never succeed.
 */
export class HighLevelReauthRequiredError extends Error {
  constructor(detail: string) {
    super(`HighLevel reconnect required: ${detail}`);
    this.name = "HighLevelReauthRequiredError";
  }
}

/** Redirect URI registered in the Marketplace app (no vendor name in the path). */
export function crmOAuthCallbackUrl(): string {
  // Use `||` (not `??`): an empty/whitespace NEXT_PUBLIC_APP_URL must fall back
  // too, otherwise we'd emit a relative redirect_uri ("/api/oauth/crm/callback")
  // that HighLevel rejects as a mismatch — the exact cause of a prod OAuth break.
  const base = (process.env.NEXT_PUBLIC_APP_URL || "").trim() || "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/api/oauth/crm/callback`;
}

/** Tokens as we store them in encrypted CRM credentials. */
export interface HighLevelTokens {
  accessToken: string;
  refreshToken: string;
  /** Location (sub-account) the token is scoped to. */
  locationId: string;
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number;
}

function clientCreds(): { clientId: string; clientSecret: string } {
  const clientId = process.env.HIGHLEVEL_CLIENT_ID;
  const clientSecret = process.env.HIGHLEVEL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "HIGHLEVEL_CLIENT_ID / HIGHLEVEL_CLIENT_SECRET are not set — required for HighLevel OAuth."
    );
  }
  return { clientId, clientSecret };
}

interface RawTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  locationId?: string;
}

function toTokens(
  json: RawTokenResponse,
  fallback: { refreshToken?: string; locationId?: string }
): HighLevelTokens {
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? fallback.refreshToken ?? "",
    locationId: json.locationId ?? fallback.locationId ?? "",
    // 60s safety margin so we never present a token in its final moments.
    expiresAt: Date.now() + (Number(json.expires_in ?? 86400) - 60) * 1000,
  };
}

async function postToken(body: URLSearchParams): Promise<RawTokenResponse> {
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
    timeoutMs: 15_000,
  });
  if (!res.ok) {
    const text = await res.text();
    // A 400 invalid_grant means the refresh token is dead — surface a typed
    // error so the engine can flag the agent for reconnect instead of retrying.
    if (res.status === 400 && /invalid_grant/i.test(text)) {
      throw new HighLevelReauthRequiredError(text.slice(0, 200));
    }
    throw new Error(`HighLevel token endpoint -> ${res.status}: ${text}`);
  }
  return (await res.json()) as RawTokenResponse;
}

/** Refresh an access token using its (rotating) refresh token. */
export async function refreshHighLevelToken(
  refreshToken: string,
  locationId: string
): Promise<HighLevelTokens> {
  const { clientId, clientSecret } = clientCreds();
  const json = await postToken(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      user_type: "Location",
    })
  );
  return toTokens(json, { refreshToken, locationId });
}

/** Exchange an authorization code (from the connect redirect) for tokens. */
export async function exchangeHighLevelCode(
  code: string,
  redirectUri: string
): Promise<HighLevelTokens> {
  const { clientId, clientSecret } = clientCreds();
  const json = await postToken(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      user_type: "Location",
      redirect_uri: redirectUri,
    })
  );
  return toTokens(json, {});
}

/** Build the HighLevel authorize URL the user is redirected to to connect. */
export function highLevelAuthorizeUrl(opts: {
  redirectUri: string;
  state: string;
  scopes?: string[];
}): string {
  const { clientId } = clientCreds();
  const scopes = opts.scopes ?? [
    "contacts.readonly",
    "contacts.write",
    "opportunities.readonly",
    "opportunities.write",
    "locations.readonly",
    // Read the location's custom-field definitions (id -> key/name) so contact
    // custom fields (interested campus/program) resolve to readable dynamic-
    // variable names instead of raw field ids. Required by getContactFieldValues.
    "locations/customFields.readonly",
    "users.readonly",
    // Conversations scopes — required to log a playable external call entry
    // (search/create conversation + add outbound call log with recording).
    "conversations.readonly",
    "conversations.write",
    "conversations/message.readonly",
    "conversations/message.write",
  ];
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: opts.redirectUri,
    scope: scopes.join(" "),
    state: opts.state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}
