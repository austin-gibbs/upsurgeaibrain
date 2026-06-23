-- Per-agent HighLevel post-call workflow webhook (Inbound Webhook trigger URL).

alter table agent_task_configs
  add column if not exists post_call_webhook_enabled boolean not null default false,
  add column if not exists post_call_webhook_url text,
  add column if not exists post_call_webhook_only_outcomes call_outcome[];

comment on column agent_task_configs.post_call_webhook_url is
  'HighLevel Workflow Inbound Webhook URL — receives call outcome JSON after each call.';
