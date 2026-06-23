-- CRM writeback observability: track how each call was finalized and whether
-- CRM writes succeeded. Enables alerting when the reconcile safety net becomes
-- the primary path (webhook degraded).

do $$ begin
  create type call_finalized_by as enum ('webhook', 'reconcile');
exception
  when duplicate_object then null;
end $$;

alter table calls
  add column if not exists finalized_by call_finalized_by,
  add column if not exists note_logged boolean,
  add column if not exists recording_logged boolean,
  add column if not exists tags_synced boolean,
  add column if not exists crm_error text;

comment on column calls.finalized_by is
  'Whether outcome processing ran via the live Retell webhook or the stuck-call reconciler sweep.';
comment on column calls.note_logged is 'True when a CRM note or call log was successfully written.';
comment on column calls.recording_logged is 'True when the call recording URL reached the CRM.';
comment on column calls.tags_synced is 'True when outcome tags were synced to the CRM.';
comment on column calls.crm_error is 'Concatenated CRM API errors when any write failed (non-fatal).';

create index if not exists calls_finalized_by_completed_idx
  on calls (finalized_by, completed_at desc nulls last)
  where completed_at is not null;
