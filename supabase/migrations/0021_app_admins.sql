-- =====================================================================
-- App-level admins (full cross-org access)
--
-- An app admin can see and edit EVERY workspace, current and future, without
-- being a member of each organization. This powers the in-app provisioning
-- console's "team members with full access" feature.
--
-- Mechanism: a boolean flag on profiles + a SECURITY DEFINER predicate
-- is_app_admin(). The existing user_org_ids() helper is widened so that, for an
-- admin, it returns ALL organization ids. Because user_workspace_ids() and
-- every downstream RLS policy derive from user_org_ids(), the bypass cascades
-- to workspaces, agents, configs, contacts, calls, and memory automatically.
--
-- The service role (engine/webhooks/console writes) already bypasses RLS, so
-- this only affects session-scoped reads/writes in the app UI.
-- =====================================================================

alter table profiles
  add column if not exists is_admin boolean not null default false;

-- True when the current session user is a flagged app admin.
create or replace function is_app_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select p.is_admin from profiles p where p.id = auth.uid()), false);
$$;

-- Widen org visibility: admins get every org; everyone else gets their memberships.
create or replace function user_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from organizations where is_app_admin()
  union
  select organization_id from organization_members where user_id = auth.uid();
$$;

-- Let admins read every profile (so the console can list team members).
-- The existing "own profile" policy still covers self read/write for everyone.
drop policy if exists "admin reads all profiles" on profiles;
create policy "admin reads all profiles" on profiles
  for select using (is_app_admin());
