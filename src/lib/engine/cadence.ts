// =====================================================================
// Cadence + eligibility.
//
// Replaces the n8n tag-state date model with typed date math. Determines
// whether a contact is eligible to be dialed today and, after a call,
// computes the next eligible date from the per-agent day-gap schedule.
// =====================================================================
import type { AgentCallConfig, Contact } from "@/types";

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
  return now >= start && now <= end;
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
