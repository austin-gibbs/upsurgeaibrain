// Shared continuous-poll scheduling helpers (scheduler + failover cron).
import {
  isCallDayAllowed,
  isHHMMWithinCallWindow,
  nowHHMMInTz,
  todayInTz,
} from "./cadence";

/** Poll cadence during the call window — one BullMQ job per bucket per agent. */
export const POLL_INTERVAL_SECONDS = 30;

/** Max age without a poll_runs row before coverage is considered missing (~3 buckets). */
export const POLL_COVERAGE_MAX_AGE_MS = POLL_INTERVAL_SECONDS * 3 * 1000;

/** Current HH:MM:SS in a timezone, for 30-second poll buckets. */
export function nowHHMMSSInTz(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const val = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const h = val("hour");
  const m = val("minute");
  const s = val("second");
  return `${h}:${m}:${s}`;
}

/** Floor HH:MM:SS to the start of its 30-second poll bucket (e.g. 09:00:45 → 09:00:30). */
export function pollBucketFromHHMMSS(hhmmss: string): string {
  const [hRaw, mRaw, sRaw] = hhmmss.split(":");
  const h = Number(hRaw);
  const m = Number(mRaw);
  const s = Number(sRaw ?? 0);
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return hhmmss;
  const bucketSecond =
    Math.floor(s / POLL_INTERVAL_SECONDS) * POLL_INTERVAL_SECONDS;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(bucketSecond).padStart(2, "0")}`;
}

/** Deterministic BullMQ poll job id for one agent + local day + 30-second bucket. */
export function buildPollJobId(agentId: string, today: string, bucket: string): string {
  return `poll:${agentId}:${today}:${bucket}`;
}

export interface PollTickEligibilityInput {
  timezone: string;
  dailyRunAt: string;
  callWindowStart: string;
  callWindowEnd: string;
  callWindowDays?: number[] | null;
  /** Override for tests — workspace-local HH:MM. */
  nowHHMM?: string;
  /** Override for tests — workspace-local YYYY-MM-DD. */
  isoDate?: string;
}

/**
 * True when an outbound agent should receive a poll job on this scheduler tick.
 * Requires: at/after daily_run_at, allowed call day, and inside the call window.
 */
export function isAgentEligibleForPollTick(input: PollTickEligibilityInput): boolean {
  const now = input.nowHHMM ?? nowHHMMInTz(input.timezone);
  if (now < input.dailyRunAt) return false;
  if (!isCallDayAllowed(input.timezone, input.callWindowDays, input.isoDate)) return false;
  if (!isHHMMWithinCallWindow(now, input.callWindowStart, input.callWindowEnd)) {
    return false;
  }
  return true;
}

/** Resolve local date + 30-second bucket for poll job id construction. */
export function pollJobBucketForTimezone(
  timezone: string,
  nowHHMMSS?: string
): { today: string; bucket: string } {
  const hhmmss = nowHHMMSS ?? nowHHMMSSInTz(timezone);
  return {
    today: todayInTz(timezone),
    bucket: pollBucketFromHHMMSS(hhmmss),
  };
}
