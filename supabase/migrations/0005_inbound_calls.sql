-- =====================================================================
-- 0005 — Inbound call support (Call Concierge / "Mia inbound" agent).
--
-- The inbound concierge answers the business line. Callers usually are NOT
-- in our `contacts` table (that table only holds enroll-tagged outbound
-- contacts), so an inbound call row must be allowed to exist without a
-- local contact. We also stamp each call's direction so the UI/reporting
-- can separate outbound dials from inbound answers.
--
-- Idempotency already exists: 0001 created a partial unique index on
-- calls(retell_call_id) where retell_call_id is not null. The inbound
-- processor relies on it.
-- =====================================================================

-- Inbound callers have no local contacts row → allow a contact-less call.
alter table calls alter column contact_id drop not null;

-- 'outbound' (existing dials) or 'inbound' (concierge answers).
alter table calls add column if not exists direction text not null default 'outbound';

create index if not exists calls_direction_idx on calls (workspace_id, direction, completed_at desc);
