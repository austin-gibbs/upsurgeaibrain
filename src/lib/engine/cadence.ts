// =====================================================================
// Cadence + eligibility.
//
// Replaces the n8n tag-state date model with typed date math. Determines
// whether a contact is eligible to be dialed today and, after a call,
// computes the next eligible date from the per-agent day-gap schedule.
// =====================================================================
import type { AgentCallConfig, Contact } from "@/types";
import { normalizeHHMM } from "@/lib/hhmm";

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

/** Current HH:MM in a timezone, for call-window checks. */
export function nowHHMMInTz(timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

export function withinCallWindow(timezone: string, start: string, end: string): boolean {
  const now = nowHHMMInTz(timezone);
  const windowStart = normalizeHHMM(start);
  const windowEnd = normalizeHHMM(end);
  return now >= windowStart && now <= windowEnd;
}

/** True when the workspace-local clock is past today's call_window_end. */
export function isPastCallWindowEnd(timezone: string, end: string): boolean {
  const now = nowHHMMInTz(timezone);
  const windowEnd = normalizeHHMM(end);
  return now > windowEnd;
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
  slotIndex: number
): number {
  const dailyCap = dailyWindowCapacity(start, end, dripSeconds);
  if (dailyCap <= 0 || slotIndex < 0) {
    return msUntilCallWindowOpens(timezone, start, end);
  }

  const dayNum = Math.floor(slotIndex / dailyCap);
  const posInDay = slotIndex % dailyCap;
  const msToNextOpen = msUntilCallWindowOpens(timezone, start, end);
  const dayMs = 24 * 3600 * 1000;

  return msToNextOpen + dayNum * dayMs + posInDay * dripSeconds * 1000;
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
  dripSeconds: number
): number {
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

/** Milliseconds until the next call-window open in a timezone (0 if open right now). */
export function msUntilCallWindowOpens(
  timezone: string,
  start: string,
  end: string
): number {
  const windowStart = normalizeHHMM(start);
  const windowEnd = normalizeHHMM(end);
  if (withinCallWindow(timezone, windowStart, windowEnd)) return 0;
  const nowSec = secondsIntoDayInTz(timezone);
  const startSec = hhmmToSeconds(windowStart);
  const deltaSec =
    nowSec < startSec ? startSec - nowSec : 24 * 3600 - nowSec + startSec;
  return deltaSec * 1000;
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
