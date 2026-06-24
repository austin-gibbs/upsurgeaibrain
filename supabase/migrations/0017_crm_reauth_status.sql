-- CRM connection health signal.
--
-- When a HighLevel refresh token is revoked/expired, every call for that
-- location fails. Previously this surfaced only as a generic per-call error that
-- BullMQ retried forever. These columns let the engine flag the connection so
-- the UI can prompt an operator to reconnect via OAuth.
--
-- null / 'connected' = healthy; 'needs_reauth' = reconnect required.
alter table public.agents add column if not exists crm_status text;
alter table public.agents add column if not exists crm_status_detail text;
alter table public.workspaces add column if not exists crm_status text;
alter table public.workspaces add column if not exists crm_status_detail text;

comment on column public.agents.crm_status is
  'CRM connection health: null/connected = ok, needs_reauth = refresh token dead, reconnect via OAuth.';
comment on column public.workspaces.crm_status is
  'CRM connection health: null/connected = ok, needs_reauth = refresh token dead, reconnect via OAuth.';
