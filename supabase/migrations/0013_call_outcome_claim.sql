-- =====================================================================
-- 0013 — atomic outcome-processing claim.
--
-- Retell re-delivers `call_analyzed`, and the stuck-call reconciler is a
-- second caller, so two outcome runs can hit the same call concurrently.
-- Without a guard they both run side effects → duplicate CRM notes, tags,
-- tasks, and a double-advanced cadence.
--
-- `outcome_claimed_at` is the mutex. process-outcome.ts atomically sets it
-- (UPDATE ... WHERE status='dialing' AND claim is null/stale) before doing
-- any side effect; only one concurrent run can win the row. It is cleared on
-- failure so a retry can reclaim, and a claim older than the processing
-- timeout is reclaimable (covers a crash mid-processing).
-- =====================================================================
alter table calls
  add column if not exists outcome_claimed_at timestamptz;
