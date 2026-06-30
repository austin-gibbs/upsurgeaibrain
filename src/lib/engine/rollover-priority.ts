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

export interface PendingQueueRowKey {
  contact_id: string;
  status: string;
}

/**
 * Pending queue rows whose contact is no longer in the CRM enroll-tag result.
 * Only `pending` rows are eligible — never cancel `dialing` (call may be in flight).
 */
export function findUnenrolledPendingQueueRows<T extends PendingQueueRowKey>(
  pendingRows: T[],
  enrolledContactIds: Set<string>
): T[] {
  return pendingRows.filter(
    (row) => row.status === "pending" && !enrolledContactIds.has(row.contact_id)
  );
}
