// Shared continuous-poll scheduling helpers (scheduler + failover cron).
import {
  isCallDayAllowed,
  isHHMMWithinCallWindow,
  nowHHMMInTz,
  todayInTz,
} from "./cadence";

/** Poll cadence during the call window — one BullMQ job per bucket per agent. */
export const POLL_INTERVAL_MINUTES = 2;

/** Floor HH:MM to the start of its 2-minute poll bucket (e.g. 09:01 → 09:00). */
export function pollBucketFromHHMM(hhmm: string): string {
  const [hRaw, mRaw] = hhmm.split(":");
  const h = Number(hRaw);
  const m = Number(mRaw);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const bucketMinute = Math.floor(m / POLL_INTERVAL_MINUTES) * POLL_INTERVAL_MINUTES;
  return `${String(h).padStart(2, "0")}:${String(bucketMinute).padStart(2, "0")}`;
}

/** Deterministic BullMQ poll job id for one agent + local day + 2-minute bucket. */
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

/** Resolve local date + 2-minute bucket for poll job id construction. */
export function pollJobBucketForTimezone(
  timezone: string,
  nowHHMM?: string
): { today: string; bucket: string } {
  const hhmm = nowHHMM ?? nowHHMMInTz(timezone);
  return {
    today: todayInTz(timezone),
    bucket: pollBucketFromHHMM(hhmm),
  };
}
