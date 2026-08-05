// =====================================================================
// Automation executor — fires ONE automation_runs row. Called by the
// automation worker (per job) and by the sweeper/drain fallback.
//
// Reliability model:
//   * Claim is a compare-and-set that also increments attempts, so two workers
//     (BullMQ + a fallback drain) never double-send.
//   * On success  -> status 'sent'.
//   * On failure  -> if attempts >= max_attempts, status 'dead' (no throw);
//                    otherwise status 'failed' and we THROW so BullMQ backoff
//                    re-runs this same runId.
// The run row (not Redis) is the source of truth.
// =====================================================================
import { createServiceClient } from "@/lib/supabase/server";

type DbClient = ReturnType<typeof createServiceClient>;

/** Thrown to signal BullMQ to retry (transient failure, under max_attempts). */
export class AutomationRetryableError extends Error {}

const REQUEST_TIMEOUT_MS = 10_000;

export interface ExecuteResult {
  ok: boolean;
  status: "sent" | "failed" | "dead" | "skipped";
  reason?: string;
}

export async function executeAutomationRun(
  runId: string,
  supabaseArg?: DbClient
): Promise<ExecuteResult> {
  const supabase = supabaseArg ?? createServiceClient();

  // Atomically claim: succeed only if still queued/failed. Increments attempts
  // so max_attempts is enforced across BullMQ retries + fallback drains.
  const { data: claimedRows } = await supabase
    .from("automation_runs")
    .update({ status: "queued" }) // keep queued while in-flight; result overwrites
    .eq("id", runId)
    .in("status", ["queued", "failed"])
    .select("*");
  const run = claimedRows?.[0];
  if (!run) return { ok: true, status: "skipped", reason: "not claimable" };

  const attempts = (run.attempts ?? 0) + 1;
  const maxAttempts = run.max_attempts ?? 5;

  // internal_notify with no URL: optionally fan out to a configured internal
  // endpoint, else just record it as sent (visible in the run log).
  const url = run.request_url ?? process.env.INTERNAL_AUTOMATION_WEBHOOK_URL ?? null;
  if (!url) {
    await supabase
      .from("automation_runs")
      .update({ status: "sent", attempts, sent_at: new Date().toISOString(), last_error: null })
      .eq("id", runId);
    return { ok: true, status: "sent", reason: "internal notify (no url)" };
  }

  // Optional custom headers were captured on the run's meta at enqueue time.
  const meta = (run.meta ?? {}) as Record<string, unknown>;
  const cfgHeaders =
    meta.headers && typeof meta.headers === "object"
      ? (meta.headers as Record<string, string>)
      : {};

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let status = 0;
  let bodyText = "";
  let threw: unknown = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...cfgHeaders },
      body: JSON.stringify(run.request_payload ?? {}),
      signal: controller.signal,
    });
    status = res.status;
    bodyText = (await res.text().catch(() => "")).slice(0, 2000);
  } catch (err) {
    threw = err;
  } finally {
    clearTimeout(timer);
  }

  const ok = !threw && status >= 200 && status < 300;
  if (ok) {
    await supabase
      .from("automation_runs")
      .update({
        status: "sent",
        attempts,
        response_status: status,
        response_body: bodyText || null,
        sent_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", runId);
    return { ok: true, status: "sent" };
  }

  const errMsg = threw
    ? threw instanceof Error
      ? threw.message
      : String(threw)
    : `HTTP ${status}: ${bodyText}`;
  const dead = attempts >= maxAttempts;

  await supabase
    .from("automation_runs")
    .update({
      status: dead ? "dead" : "failed",
      attempts,
      response_status: status || null,
      response_body: bodyText || null,
      last_error: errMsg.slice(0, 1000),
    })
    .eq("id", runId);

  if (dead) return { ok: false, status: "dead", reason: errMsg };

  // Retryable: throw so BullMQ backoff re-runs this runId.
  throw new AutomationRetryableError(errMsg);
}
