-- Security-advisor hardening (Supabase database linter).
--
-- 1. function_search_path_mutable (advisor 0011): pin search_path on functions
--    that lacked it, so a role-mutable search_path can't be used to shadow
--    objects the function references.
alter function public.seed_default_outcome_tags(uuid) set search_path = public;
alter function public.set_updated_at() set search_path = public;

-- 2. {anon,authenticated}_security_definer_function_executable (advisors
--    0028/0029): handle_new_user() is a SECURITY DEFINER trigger on auth.users.
--    It must never be callable as an RPC by API roles. Revoking the default
--    PUBLIC grant removes anon + authenticated execute; the trigger is unaffected
--    (it fires as the table owner).
revoke execute on function public.handle_new_user() from public;
revoke execute on function public.handle_new_user() from anon, authenticated;

-- NOTE: user_org_ids() and user_workspace_ids() are intentionally left
-- executable by `authenticated` — the RLS policies call them, so revoking would
-- break row access. They return only the caller's own org/workspace ids.
