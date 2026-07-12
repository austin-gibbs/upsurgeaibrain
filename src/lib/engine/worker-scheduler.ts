// Worker scheduler mode helpers — keep the internal 30s loop on by default.
// External cron (/api/cron/daily-poll) is a redundant backup; BullMQ poll job
// ids are already idempotent per agent + local date + 30-second bucket.

type EnvLike = Record<string, string | undefined>;

/**
 * True when the Railway/local worker should run its own scheduler tick loop.
 * Opt out only with an explicit DISABLE_INTERNAL_SCHEDULER=true.
 *
 * Legacy USE_EXTERNAL_CRON=true no longer disables the internal scheduler —
 * both can safely coexist.
 */
export function shouldRunInternalScheduler(
  env: EnvLike = process.env
): boolean {
  const raw = env.DISABLE_INTERNAL_SCHEDULER?.trim().toLowerCase();
  return raw !== "true" && raw !== "1" && raw !== "yes";
}

export function describeSchedulerMode(env: EnvLike = process.env): string {
  if (shouldRunInternalScheduler(env)) {
    return "internal 30s non-overlapping loop (external cron may also run as backup)";
  }
  return "internal scheduler disabled (DISABLE_INTERNAL_SCHEDULER=true — ensure /api/cron/daily-poll is active)";
}
