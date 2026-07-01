// =====================================================================
// Cadence + eligibility.
//
// Replaces the n8n tag-state date model with typed date math. Determines
// whether a contact is eligible to be dialed today and, after a call,
// computes the next eligible date from the per-agent day-gap schedule.
// =====================================================================
import type { AgentCallConfig, Contact } from "@/types";
import { DEFAULT_CALL_WINDOW_DAYS } from "@/types";
import { normalizeHHMM } from "@/lib/hhmm";

const WEEKDAY_SHORT_TO_ISO: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** Normalize ISO weekday array (1=Mon … 7=Sun). */
export function normalizeCallWindowDays(
  days?: number[] | null
): number[] {
  if (!days?.length) return [...DEFAULT_CALL_WINDOW_DAYS];
  const unique = [
    ...new Set(days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)),
  ].sort((a, b) => a - b);
  return unique.length ? unique : [...DEFAULT_CALL_WINDOW_DAYS];
}

/** ISO weekday (1=Mon … 7=Sun) for a YYYY-MM-DD date in a timezone. */
export function isoWeekdayInTz(timezone: string, isoDate?: string): number {
  const date = isoDate ?? todayInTz(timezone);
  const noonUtc = zonedDateTimeToUtcIso(timezone, date, "12:00");
  const short = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(new Date(noonUtc));
  return WEEKDAY_SHORT_TO_ISO[short] ?? 1;
}

/** True when the given calendar day is an allowed call day. */
export function isCallDayAllowed(
  timezone: string,
  days?: number[] | null,
  isoDate?: string
): boolean {
  const allowed = normalizeCallWindowDays(days);
  return allowed.includes(isoWeekdayInTz(timezone, isoDate));
}

/** Today's date (YYYY-MM-DD) in a given IANA timezone. */
export function todayInTz(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Add `days` to a YYYY-MM-DD string, returning YYYY-MM-DD. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Milliseconds offset (wall-clock minus UTC) of an IANA timezone at a given
 * UTC instant. Positive east of UTC, negative west. Handles DST because the
 * offset is read at that specific instant.
 */
function tzOffsetMs(timezone: string, instantMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(instantMs));
  const val = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(
    val("year"),
    val("month") - 1,
    val("day"),
    val("hour") % 24, // en-US can emit "24" at midnight
    val("minute"),
    val("second")
  );
  return asUtc - instantMs;
}

/**
 * Express a wall-clock time (HH:MM) on a YYYY-MM-DD calendar date in an IANA
 * timezone as a UTC ISO timestamp. Used for fixed task due-times (e.g. "today
 * at 05:00 America/New_York") so the due moment is the same regardless of when
 * the call actually completes. Correct across EST/EDT transitions.
 */
export function zonedDateTimeToUtcIso(
  timezone: string,
  isoDate: string,
  hhmm: string
): string {
  const [h, m] = normalizeHHMM(hhmm).split(":").map(Number);
  const [y, mo, d] = isoDate.split("-").map(Number);
  // Treat the wall time as if it were UTC, then correct by the zone's offset at
  // that instant. One pass converges for fixed-time-of-day values like 05:00.
  const utcGuess = Date.UTC(y, mo - 1, d, h, m, 0);
  const offset = tzOffsetMs(timezone, utcGuess);
  return new Date(utcGuess - offset).toISOString();
}

/** Current HH:MM in a timezone, for call-window checks. */
export function nowHHMMInTz(timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

/** Compare a workspace-local HH:MM against inclusive call-window bounds. */
export function isHHMMWithinCallWindow(nowHHMM: string, start: string, end: string): boolean {
  const now = normalizeHHMM(nowHHMM);
  const windowStart = normalizeHHMM(start);
  const windowEnd = normalizeHHMM(end);
  return now >= windowStart && now <= windowEnd;
}

export function withinCallWindow(timezone: string, start: string, end: string): boolean {
  return isHHMMWithinCallWindow(nowHHMMInTz(timezone), start, end);
}

/** True when the workspace-local clock is past today's call_window_end. */
export function isPastCallWindowEnd(timezone: string, end: string): boolean {
  const now = nowHHMMInTz(timezone);
  const windowEnd = normalizeHHMM(end);
  return now > windowEnd;
}

/** True when dialing is closed for today (off-day or past window end). */
export function isCallWindowClosedForToday(
  timezone: string,
  end: string,
  days?: number[] | null
): boolean {
  if (!isCallDayAllowed(timezone, days)) return true;
  return isPastCallWindowEnd(timezone, end);
}

function secondsIntoDayInTz(timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const val = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const hour = val("hour") % 24;
  return hour * 3600 + val("minute") * 60 + val("second");
}

export function hhmmToSeconds(hhmm: string): number {
  const [h, m] = normalizeHHMM(hhmm).split(":").map(Number);
  return h * 3600 + m * 60;
}

/**
 * Project dial date/time for a 0-based queue position on an earliest date.
 * When today's slot at window start + drip is already past `nowHHMM`, roll to
 * the next calendar day (Ops UI + schedule projection).
 */
export function projectDialSlot(
  earliestDate: string,
  today: string,
  nowHHMM: string,
  windowStart: string,
  positionInDay: number,
  dripSeconds: number
): { runDate: string; slotSeconds: number } {
  const windowStartSec = hhmmToSeconds(windowStart);
  const nowSec = hhmmToSeconds(nowHHMM);
  let runDate = earliestDate;
  let slotSeconds = windowStartSec + positionInDay * dripSeconds;

  if (runDate === today && slotSeconds <= nowSec) {
    runDate = addDays(today, 1);
    slotSeconds = windowStartSec + positionInDay * dripSeconds;
  }

  return { runDate, slotSeconds };
}

/** Roll a stored schedule timestamp forward day-by-day until it is in the future. */
export function rollScheduleForwardIfPast(
  scheduledForIso: string,
  referenceMs: number = Date.now()
): string {
  let ms = new Date(scheduledForIso).getTime();
  if (Number.isNaN(ms) || ms >= referenceMs) return scheduledForIso;
  const dayMs = 24 * 3600 * 1000;
  while (ms < referenceMs) ms += dayMs;
  return new Date(ms).toISOString();
}

// Re-export for callers that already import from cadence.
export { normalizeHHMM } from "@/lib/hhmm";

/**
 * Milliseconds from now until queue slot `slotIndex` (0-based) at the given
 * drip spacing. Slot 0 lands at the next window open (or immediately if open).
 */
export function msUntilQueueSlot(
  timezone: string,
  start: string,
  end: string,
  dripSeconds: number,
  slotIndex: number,
  days?: number[] | null
): number {
  const allowedDays = normalizeCallWindowDays(days);
  const dailyCap = dailyWindowCapacity(start, end, dripSeconds);
  if (dailyCap <= 0 || slotIndex < 0) {
    return msUntilCallWindowOpens(timezone, start, end, allowedDays);
  }

  const allowedDayNum = Math.floor(slotIndex / dailyCap);
  const posInDay = slotIndex % dailyCap;
  const msToDay = msToAllowedDayWindowStart(
    timezone,
    allowedDays,
    allowedDayNum,
    start,
    end
  );
  return msToDay + posInDay * dripSeconds * 1000;
}

/** Ms from now until window start on the Nth allowed dialing day (0-based). */
function msToAllowedDayWindowStart(
  timezone: string,
  days: number[],
  allowedDayIndex: number,
  start: string,
  end: string
): number {
  const today = todayInTz(timezone);
  const windowStart = normalizeHHMM(start);
  const windowEnd = normalizeHHMM(end);
  const nowSec = secondsIntoDayInTz(timezone);
  const startSec = hhmmToSeconds(windowStart);
  const endSec = hhmmToSeconds(windowEnd);

  let seen = -1;
  for (let offset = 0; offset <= 60; offset++) {
    const date = addDays(today, offset);
    if (!isCallDayAllowed(timezone, days, date)) continue;
    if (offset === 0 && nowSec > endSec) continue;

    seen++;
    if (seen !== allowedDayIndex) continue;

    if (offset === 0 && nowSec < startSec) {
      return (startSec - nowSec) * 1000;
    }
    if (offset === 0 && nowSec >= startSec && nowSec <= endSec) {
      return 0;
    }

    const secUntilMidnight = 24 * 3600 - nowSec;
    return (secUntilMidnight + (offset - 1) * 24 * 3600 + startSec) * 1000;
  }

  return 7 * 24 * 3600 * 1000;
}

/**
 * Max dials that fit inside a call window at the given drip spacing.
 * First dial lands at window start; each subsequent dial is drip_seconds later.
 */
export function dailyWindowCapacity(
  start: string,
  end: string,
  dripSeconds: number
): number {
  if (dripSeconds <= 0) return 0;
  const windowStart = normalizeHHMM(start);
  const windowEnd = normalizeHHMM(end);
  const windowSeconds = hhmmToSeconds(windowEnd) - hhmmToSeconds(windowStart);
  if (windowSeconds <= 0) return 0;
  return Math.floor(windowSeconds / dripSeconds) + 1;
}

/**
 * How many dials can still fit today from the current moment until window end.
 * Before window open, returns the full daily capacity; after window close, 0.
 */
export function remainingWindowCapacity(
  timezone: string,
  start: string,
  end: string,
  dripSeconds: number,
  days?: number[] | null
): number {
  if (!isCallDayAllowed(timezone, days)) return 0;
  if (dripSeconds <= 0) return 0;
  const windowStart = normalizeHHMM(start);
  const windowEnd = normalizeHHMM(end);
  const nowSec = secondsIntoDayInTz(timezone);
  const startSec = hhmmToSeconds(windowStart);
  const endSec = hhmmToSeconds(windowEnd);
  if (nowSec >= endSec) return 0;
  if (nowSec < startSec) {
    return dailyWindowCapacity(windowStart, windowEnd, dripSeconds);
  }
  const remainingSeconds = endSec - nowSec;
  return Math.floor(remainingSeconds / dripSeconds) + 1;
}

/**
 * How many contacts a poll may enqueue right now. During an open call window,
 * respects remaining slots today. After hours or before open, uses the full
 * daily window capacity — dial jobs are delayed via msUntilCallWindowOpens.
 */
export function pollEnqueueCapacity(
  timezone: string,
  start: string,
  end: string,
  dripSeconds: number,
  days?: number[] | null
): number {
  const windowStart = normalizeHHMM(start);
  const windowEnd = normalizeHHMM(end);
  const allowedDays = normalizeCallWindowDays(days);

  if (
    isCallDayAllowed(timezone, allowedDays) &&
    withinCallWindow(timezone, windowStart, windowEnd)
  ) {
    return remainingWindowCapacity(
      timezone,
      start,
      end,
      dripSeconds,
      days
    );
  }

  return dailyWindowCapacity(windowStart, windowEnd, dripSeconds);
}

/** Milliseconds until the next call-window open in a timezone (0 if open right now). */
export function msUntilCallWindowOpens(
  timezone: string,
  start: string,
  end: string,
  days?: number[] | null
): number {
  const windowStart = normalizeHHMM(start);
  const windowEnd = normalizeHHMM(end);
  const allowedDays = normalizeCallWindowDays(days);
  const today = todayInTz(timezone);

  if (
    isCallDayAllowed(timezone, allowedDays, today) &&
    withinCallWindow(timezone, windowStart, windowEnd)
  ) {
    return 0;
  }

  const nowSec = secondsIntoDayInTz(timezone);
  const startSec = hhmmToSeconds(windowStart);
  const endSec = hhmmToSeconds(windowEnd);

  if (isCallDayAllowed(timezone, allowedDays, today) && nowSec < startSec) {
    return (startSec - nowSec) * 1000;
  }

  for (let offset = 1; offset <= 7; offset++) {
    const date = addDays(today, offset);
    if (!isCallDayAllowed(timezone, allowedDays, date)) continue;

    const secUntilMidnight = 24 * 3600 - nowSec;
    return (secUntilMidnight + (offset - 1) * 24 * 3600 + startSec) * 1000;
  }

  return 24 * 3600 * 1000;
}

// ---------------------------------------------------------------------------
// Hard business-hours guard (global). Independent of per-agent config so a
// misconfiguration can never dial outside hours: never place a call before
// 9:00am or after 7:00pm Eastern. America/New_York tracks EST/EDT, so the
// window stays at 9am–7pm Eastern wall-clock year-round.
// ---------------------------------------------------------------------------
export const EASTERN_TZ = "America/New_York";
const EASTERN_OPEN_SEC = 9 * 3600; // 09:00
const EASTERN_CLOSE_SEC = 19 * 3600; // 19:00 (7:00pm)

function easternSecondsIntoDay(): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: EASTERN_TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const val = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const hour = val("hour") % 24; // en-GB can emit "24" at midnight
  return hour * 3600 + val("minute") * 60 + val("second");
}

/** True only between 9:00am (inclusive) and 7:00pm (exclusive) Eastern. */
export function withinEasternBusinessHours(): boolean {
  const s = easternSecondsIntoDay();
  return s >= EASTERN_OPEN_SEC && s < EASTERN_CLOSE_SEC;
}

/** Milliseconds until the next 9:00am Eastern open (0 if open right now). */
export function msUntilEasternWindowOpens(): number {
  const s = easternSecondsIntoDay();
  if (s >= EASTERN_OPEN_SEC && s < EASTERN_CLOSE_SEC) return 0;
  const deltaSec =
    s < EASTERN_OPEN_SEC ? EASTERN_OPEN_SEC - s : 24 * 3600 - s + EASTERN_OPEN_SEC;
  return deltaSec * 1000;
}

export interface CallWindowDecision {
  /** True when a dial may be placed right now. */
  allowed: boolean;
  /** If not allowed, ms to wait until the window next opens (min 60s). */
  deferMs: number;
  /** Human-readable reason, used for deferral logs. */
  reason: string;
}

/**
 * Single source of truth for "may we dial right now?". Uses the agent's
 * configured call window in the workspace timezone. When start/end are
 * missing, falls back to 09:00–19:00 in that timezone so unconfigured
 * agents still have a safe default — each workspace/agent is independent.
 *
 * Both the call worker (fast pre-check) and placeCall (authoritative backstop)
 * call this, so the window is enforced identically everywhere.
 */
export function evaluateDialWindow(
  timezone: string,
  start?: string | null,
  end?: string | null,
  days?: number[] | null
): CallWindowDecision {
  const windowStart = normalizeHHMM(start ?? "09:00");
  const windowEnd = normalizeHHMM(end ?? "19:00");
  const allowedDays = normalizeCallWindowDays(days);

  if (!isCallDayAllowed(timezone, allowedDays)) {
    return {
      allowed: false,
      deferMs: Math.max(
        msUntilCallWindowOpens(timezone, windowStart, windowEnd, allowedDays),
        60_000
      ),
      reason: `outside agent call days [${allowedDays.join(",")}] ${timezone}`,
    };
  }

  if (!withinCallWindow(timezone, windowStart, windowEnd)) {
    return {
      allowed: false,
      deferMs: Math.max(
        msUntilCallWindowOpens(timezone, windowStart, windowEnd, allowedDays),
        60_000
      ),
      reason: `outside agent window ${windowStart}-${windowEnd} ${timezone}`,
    };
  }
  return { allowed: true, deferMs: 0, reason: "within window" };
}

/**
 * Is this contact eligible to be dialed today?
 * Mirrors the WF1 "Filter Eligible Contacts" gates, now typed:
 *   - not terminal (appointment / not_interested / dnd)
 *   - under the per-contact attempt cap
 *   - not already called today
 *   - past its next-eligible date
 */
export function isEligible(
  contact: Contact,
  config: AgentCallConfig,
  today: string
): boolean {
  if (contact.is_terminal) return false;
  if (contact.attempt_count >= config.max_attempts_per_contact) return false;
  if (contact.last_called_on === today) return false;
  if (contact.next_eligible_on && contact.next_eligible_on > today) return false;
  return true;
}

/**
 * Next eligible date after an attempt. Uses cadence_day_gaps indexed by the
 * attempt just completed (1-based). Falls back to the last gap for attempts
 * beyond the array length.
 */
export function nextEligibleDate(
  attemptJustCompleted: number,
  config: AgentCallConfig,
  today: string
): string {
  const gaps = config.cadence_day_gaps;
  const idx = Math.min(attemptJustCompleted, gaps.length - 1);
  const gapDays = gaps[idx] ?? gaps[gaps.length - 1] ?? 1;
  return addDays(today, Math.max(gapDays, 1));
}
