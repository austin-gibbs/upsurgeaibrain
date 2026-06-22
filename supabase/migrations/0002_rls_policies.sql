-- =====================================================================
-- Row Level Security
--
-- Principle: a user can see/modify a row only if they are a member of the
-- organization that owns it. The service-role key (used by the call engine
-- and webhooks) bypasses RLS entirely, so background jobs are unaffected.
-- =====================================================================

alter table profiles                enable row level security;
alter table organizations           enable row level security;
alter table organization_members    enable row level security;
alter table workspaces              enable row level security;
alter table workspace_outcome_tags  enable row level security;
alter table agents                  enable row level security;
alter table agent_call_configs      enable row level security;
alter table agent_task_configs      enable row level security;
alter table contacts                enable row level security;
alter table calls                   enable row level security;
alter table agent_memory            enable row level security;

-- Helper: orgs the current user belongs to
create or replace function user_org_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select organization_id from organization_members where user_id = auth.uid();
$$;

-- Helper: workspaces the current user can access
create or replace function user_workspace_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select w.id from workspaces w where w.organization_id in (select user_org_ids());
$$;

-- profiles: a user sees/edits only their own row
create policy "own profile" on profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

-- organizations
create policy "member can read org" on organizations
  for select using (id in (select user_org_ids()));
create policy "any auth user can create org" on organizations
  for insert with check (auth.uid() is not null);

-- organization_members: visible to members of the same org
create policy "read org members" on organization_members
  for select using (organization_id in (select user_org_ids()));
create policy "manage own membership" on organization_members
  for insert with check (user_id = auth.uid());

-- workspaces and everything below: scope by org / workspace membership
create policy "rw workspaces" on workspaces
  for all using (organization_id in (select user_org_ids()))
  with check (organization_id in (select user_org_ids()));

create policy "rw outcome tags" on workspace_outcome_tags
  for all using (workspace_id in (select user_workspace_ids()))
  with check (workspace_id in (select user_workspace_ids()));

create policy "rw agents" on agents
  for all using (workspace_id in (select user_workspace_ids()))
  with check (workspace_id in (select user_workspace_ids()));

create policy "rw call configs" on agent_call_configs
  for all using (agent_id in (select id from agents where workspace_id in (select user_workspace_ids())))
  with check (agent_id in (select id from agents where workspace_id in (select user_workspace_ids())));

create policy "rw task configs" on agent_task_configs
  for all using (agent_id in (select id from agents where workspace_id in (select user_workspace_ids())))
  with check (agent_id in (select id from agents where workspace_id in (select user_workspace_ids())));

create policy "rw contacts" on contacts
  for all using (workspace_id in (select user_workspace_ids()))
  with check (workspace_id in (select user_workspace_ids()));

create policy "rw calls" on calls
  for all using (workspace_id in (select user_workspace_ids()))
  with check (workspace_id in (select user_workspace_ids()));

create policy "rw agent memory" on agent_memory
  for all using (workspace_id in (select user_workspace_ids()))
  with check (workspace_id in (select user_workspace_ids()));
