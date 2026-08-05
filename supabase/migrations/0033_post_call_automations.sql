-- =====================================================================
-- 0033 — Post-call automation engine (config-driven triggers).
--
-- Productizes the existing per-agent post-call webhook (see
-- src/lib/webhooks/post-call.ts, which fires ONE URL keyed only on outcome)
-- into a config-driven rule engine: many triggers per workspace/agent, each
-- matching on the Retell `custom_analysis_data` fields the agent emits
-- (e.g. link_requested=true, link_type="buyer_guide"), then firing an action
-- (webhook to a HighLevel Inbound Webhook, or internal notify) with a durable
-- queue, retry, and dead-letter.
--
-- Design:
--   * automation_triggers — the rule set. A new automation is a new ROW, never
--     a code deploy. Scoped to a workspace; agent_id NULL = all agents.
--   * automation_links   — per-workspace link map keyed by link_type, so the
--     APP owns which URL is sent and the HighLevel workflow stays "dumb" and
--     identical across every client.
--   * automation_runs    — queue + audit log. Every match becomes a row; the
--     executor worker drives it queued -> sent | failed | dead. Source of
--     truth for retries and dedupe.
--
-- Conventions mirror 0030/0032: workspace-scoped, shared set_updated_at()
-- trigger, RLS via user_workspace_ids() for member reads; the service role
-- (engine/webhooks/worker) bypasses RLS entirely.
-- =====================================================================

-- ---------------------------------------------------------------------
-- automation_triggers — the config-driven rule set.
-- ---------------------------------------------------------------------
create table if not exists automation_triggers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  -- NULL = applies to every agent in the workspace; otherwise scoped to one.
  agent_id uuid references agents (id) on delete cascade,
  name text not null,
  description text,
  enabled boolean not null default true,
  -- Condition logic: 'all' = AND, 'any' = OR across `conditions`.
  match_type text not null default 'all'
    check (match_type in ('all', 'any')),
  -- [{ "field":"link_requested", "operator":"is_true" },
  --  { "field":"link_type", "operator":"eq", "value":"buyer_guide" }]
  -- Fields are read from Retell custom_analysis_data plus a few call-context
  -- pseudo-fields (outcome, summary, transcript). Operators:
  --   is_true | is_false | eq | neq | contains | exists | not_exists | in
  conditions jsonb not null default '[]'::jsonb,
  -- Action to fire when the conditions match.
  action_type text not null default 'webhook'
    check (action_type in ('webhook', 'highlevel_sms', 'internal_notify')),
  -- webhook/highlevel_sms:
  --   { "url":"https://services.leadconnectorhq.com/hooks/…",
  --     "method":"POST", "headers":{...},
  --     "message_template":"Here is the guide you asked for: {{link.url}}",
  --     "link_type_field":"link_type",        -- which analysis field names the link
  --     "static_link_type":"buyer_guide",     -- OR pin one link_type
  --     "payload_template":{...} }            -- optional custom body
  action_config jsonb not null default '{}'::jsonb,
  -- Reliability
  dedupe_window_hours int not null default 24,  -- 0 = never dedupe
  max_attempts int not null default 5,
  -- Only fire on these canonical outcomes (empty/null = every outcome).
  only_outcomes text[],
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists automation_triggers_workspace_idx
  on automation_triggers (workspace_id, enabled);
create index if not exists automation_triggers_agent_idx
  on automation_triggers (agent_id);

create trigger trg_automation_triggers_updated before update on automation_triggers
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- automation_links — per-workspace link map keyed by link_type.
-- ---------------------------------------------------------------------
create table if not exists automation_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  link_type text not null,               -- buyer_guide | seller_guide | ...
  url text not null,
  label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, link_type)
);

create index if not exists automation_links_workspace_idx
  on automation_links (workspace_id);

create trigger trg_automation_links_updated before update on automation_links
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- automation_runs — durable queue + audit log. One row per match.
-- ---------------------------------------------------------------------
create table if not exists automation_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  trigger_id uuid references automation_triggers (id) on delete set null,
  agent_id uuid references agents (id) on delete set null,
  -- Our internal call row + the Retell id, for tracing back to the call.
  call_id uuid references calls (id) on delete set null,
  retell_call_id text,
  contact_id uuid references contacts (id) on delete set null,
  contact_phone text,                    -- E.164 target, for dedupe + display
  -- Lifecycle: queued -> sent | failed (retryable) | dead (max attempts) | skipped
  status text not null default 'queued'
    check (status in ('queued', 'sent', 'failed', 'dead', 'skipped')),
  attempts int not null default 0,
  max_attempts int not null default 5,
  action_type text,
  -- Resolved request the executor will send (URL + rendered payload).
  request_url text,
  request_payload jsonb,
  -- Last delivery result, for the run log UI + debugging.
  response_status int,
  response_body text,
  last_error text,
  -- Free-form context (matched link_type, resolved link url, condition snapshot).
  meta jsonb not null default '{}'::jsonb,
  scheduled_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists automation_runs_status_sched_idx
  on automation_runs (status, scheduled_at);
create index if not exists automation_runs_workspace_idx
  on automation_runs (workspace_id, created_at desc);
create index if not exists automation_runs_trigger_idx
  on automation_runs (trigger_id, created_at desc);
-- Dedupe support: quickly find prior sent runs for a trigger + contact phone.
create index if not exists automation_runs_dedupe_idx
  on automation_runs (trigger_id, contact_phone, status, created_at desc);

create trigger trg_automation_runs_updated before update on automation_runs
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- RLS — org members read their workspace's rows; the service role
-- (engine/webhooks/worker/console writes) bypasses RLS entirely, so all
-- writes happen there. Admin UI writes go through service-role console routes.
-- ---------------------------------------------------------------------
alter table automation_triggers enable row level security;
alter table automation_links enable row level security;
alter table automation_runs enable row level security;

create policy "member reads automation_triggers" on automation_triggers
  for select using (workspace_id in (select user_workspace_ids()));

create policy "member reads automation_links" on automation_links
  for select using (workspace_id in (select user_workspace_ids()));

create policy "member reads automation_runs" on automation_runs
  for select using (workspace_id in (select user_workspace_ids()));
