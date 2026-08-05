-- =====================================================================
-- 0035 — Post-call automation direction scope
--
-- Lets a trigger fire on inbound calls, outbound calls, or both. Existing
-- rows default to 'all' so outbound behaviour is unchanged on deploy.
-- =====================================================================

alter table automation_triggers
  add column if not exists direction_scope text not null default 'all';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'automation_triggers_direction_scope_check'
  ) then
    alter table automation_triggers
      add constraint automation_triggers_direction_scope_check
      check (direction_scope in ('all', 'inbound', 'outbound'));
  end if;
end $$;

comment on column automation_triggers.direction_scope is
  'Which call direction this trigger matches: all | inbound | outbound. Default all preserves pre-0035 behaviour.';
