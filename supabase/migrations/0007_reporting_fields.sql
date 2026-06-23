-- Reporting dashboard: CRM deep-links, contact email, denormalized call identity.

alter table workspaces
  add column if not exists crm_account_url text;

comment on column workspaces.crm_account_url is
  'Base URL for CRM contact pages, e.g. https://nilpatel.followupboss.com';

alter table contacts
  add column if not exists email text;

alter table calls
  add column if not exists crm_contact_id text,
  add column if not exists contact_name text,
  add column if not exists contact_email text;

create index if not exists calls_workspace_completed_idx
  on calls (workspace_id, completed_at desc nulls last);

create index if not exists calls_retell_lookup_idx
  on calls (retell_call_id)
  where retell_call_id is not null;
