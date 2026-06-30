-- Poll run audit log — one row per pollAgent completion for post-hoc review.

create table if not exists public.poll_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  ran_at timestamptz not null default now(),
  scanned integer not null default 0,
  eligible integer not null default 0,
  enqueued integer not null default 0,
  cancelled integer not null default 0,
  tags_stripped integer not null default 0,
  trigger_source text not null default 'worker',
  skipped_reason text,
  test_mode boolean not null default false
);

create index if not exists poll_runs_workspace_ran_at_idx
  on public.poll_runs (workspace_id, ran_at desc);

create index if not exists poll_runs_agent_ran_at_idx
  on public.poll_runs (agent_id, ran_at desc);

alter table public.poll_runs enable row level security;

-- Org members can read poll history for workspaces in their org.
create policy poll_runs_select on public.poll_runs
  for select
  using (
    exists (
      select 1
      from public.workspaces w
      join public.organization_members om on om.organization_id = w.organization_id
      where w.id = poll_runs.workspace_id
        and om.user_id = auth.uid()
    )
  );
