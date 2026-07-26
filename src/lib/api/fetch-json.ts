/**
 * Safely parse a fetch Response as JSON.
 *
 * Gateway timeouts, middleware hangs, and HTML error pages return plain text
 * (e.g. "An error occurred..." / "504: GATEWAY_TIMEOUT"). Calling res.json()
 * on those bodies throws a cryptic "Unexpected token 'A'... is not valid JSON".
 * This helper reads text first and throws a readable Error instead.
 */
export async function readJson<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) {
    if (!res.ok) {
      throw new Error(requestFailedMessage(res));
    }
    return {} as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(requestFailedMessage(res, text));
  }
}

function requestFailedMessage(res: Response, body?: string): string {
  const statusLabel = res.statusText
    ? `${res.status} ${res.statusText}`
    : String(res.status || "unknown");

  if (!body) {
    return `Request failed (${statusLabel})`;
  }

  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 120);
  // Prefer a clean status line for known gateway/platform errors.
  if (/GATEWAY_TIMEOUT|MIDDLEWARE_INVOCATION_TIMEOUT|An error o/i.test(body)) {
    return `Request failed (${statusLabel})`;
  }
  return `Request failed (${statusLabel}): ${snippet}`;
}
