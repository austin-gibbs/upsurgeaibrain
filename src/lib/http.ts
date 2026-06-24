// =====================================================================
// Shared HTTP helpers for outbound API calls (CRM + Retell).
//
// Node's global fetch has NO default timeout. The call worker runs at high
// concurrency, so a handful of stalled sockets (slow Retell, hung FUB) can
// exhaust every worker slot and silently halt outbound calling. Every
// outbound fetch in this codebase goes through `fetchWithTimeout` so a hung
// peer aborts instead of wedging the worker.
// =====================================================================

/** Thrown when a request exceeds its timeout. BullMQ treats it as retryable. */
export class HttpTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`request to ${url} timed out after ${timeoutMs}ms`);
    this.name = "HttpTimeoutError";
  }
}

export interface FetchWithTimeoutInit extends RequestInit {
  /** Abort the request after this many ms. Default 15s. */
  timeoutMs?: number;
}

/**
 * fetch() with a hard timeout via AbortSignal. Merges any caller-provided
 * signal so external cancellation still works. Re-throws an `HttpTimeoutError`
 * on timeout so callers/queues can distinguish it from a real HTTP error.
 */
export async function fetchWithTimeout(
  url: string,
  init: FetchWithTimeoutInit = {}
): Promise<Response> {
  const { timeoutMs = 15_000, signal: callerSignal, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Honor a caller-supplied signal in addition to our timeout.
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError" && !callerSignal?.aborted) {
      throw new HttpTimeoutError(url, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a Response body as JSON, but fail loudly with status + a body snippet
 * instead of an opaque SyntaxError when the peer returns HTML/empty on a 200.
 */
export async function parseJsonResponse<T>(res: Response, label: string): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text.trim()) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `${label}: expected JSON but got ${res.status} ${res.headers.get("content-type") ?? "?"} — ${text.slice(0, 200)}`
    );
  }
}

/** Bounded sleep used by Retry-After backoff. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a `Retry-After` header (seconds or HTTP-date) into milliseconds,
 * clamped to [0, maxMs]. Returns a default when the header is absent.
 */
export function retryAfterMs(
  header: string | null,
  defaultMs = 2_000,
  maxMs = 30_000
): number {
  if (!header) return defaultMs;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds)) return Math.min(Math.max(asSeconds * 1000, 0), maxMs);
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.min(Math.max(asDate - Date.now(), 0), maxMs);
  return defaultMs;
}
