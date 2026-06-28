// Rollover-first queue ordering and poll capacity helpers.
// Missed calls (queue_day < today) must dial before new same-day rows.

export interface QueueRowSortKey {
  queue_day: string;
  position: number;
  enqueued_at?: string | null;
}

/** Sort pending rows: oldest queue_day first, then position, then enqueued_at. */
export function compareQueueRowsForRollover(a: QueueRowSortKey, b: QueueRowSortKey): number {
  if (a.queue_day !== b.queue_day) return a.queue_day.localeCompare(b.queue_day);
  if (a.position !== b.position) return a.position - b.position;
  const ea = a.enqueued_at ?? "";
  const eb = b.enqueued_at ?? "";
  return ea.localeCompare(eb);
}

/** New contacts may only use capacity left after rollover backlog. */
export function computeNewPollCapacity(dailyCap: number, rolloverBacklogCount: number): number {
  return Math.max(0, dailyCap - Math.max(0, rolloverBacklogCount));
}

/** Remaining daily dial budget after calls already placed today. */
export function remainingDailyDialBudget(
  maxCallsPerDay: number,
  dialedTodayCount: number
): number {
  return Math.max(0, maxCallsPerDay - Math.max(0, dialedTodayCount));
}

/** Exclude contacts that already have a pending/dialing queue row. */
export function excludeActiveQueuedContacts<T extends { id: string }>(
  contacts: T[],
  activeQueuedIds: Set<string>
): T[] {
  return contacts.filter((c) => !activeQueuedIds.has(c.id));
}
