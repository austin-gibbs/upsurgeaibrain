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
const TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
const AUTHORIZE_URL = "https://marketplace.gohighlevel.com/oauth/chooselocation";

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
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
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
    "users.readonly",
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
