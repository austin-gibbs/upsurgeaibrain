-- Per-agent call window weekdays (ISO: 1=Mon … 7=Sun). Defaults preserve
-- existing every-calendar-day behavior.

create or replace function public.is_valid_call_window_days(days int[])
returns boolean
language plpgsql
immutable
as $$
declare
  d int;
  seen int[] := '{}';
begin
  if days is null or cardinality(days) < 1 then
    return false;
  end if;
  foreach d in array days loop
    if d < 1 or d > 7 then
      return false;
    end if;
    if d = any(seen) then
      return false;
    end if;
    seen := array_append(seen, d);
  end loop;
  return true;
end;
$$;

alter table agent_call_configs
  add column if not exists call_window_days int[] not null
    default array[1, 2, 3, 4, 5, 6, 7];

alter table agent_call_configs
  drop constraint if exists agent_call_configs_call_window_days_check;

alter table agent_call_configs
  add constraint agent_call_configs_call_window_days_check
  check (public.is_valid_call_window_days(call_window_days));
