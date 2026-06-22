-- =====================================================================
-- Default outcome-tag taxonomy + new-user/profile bootstrap
-- =====================================================================

-- Seed the 7-tag taxonomy (matches the production n8n system) for a new
-- workspace. Called by the provisioning API after a workspace is created.
create or replace function seed_default_outcome_tags(p_workspace_id uuid)
returns void language plpgsql as $$
begin
  insert into workspace_outcome_tags (workspace_id, outcome, tag, is_terminal) values
    (p_workspace_id, 'voicemail',                 'upsurge-voicemail-ai',            false),
    (p_workspace_id, 'no_answer',                 'upsurge-noanswer-ai',             false),
    (p_workspace_id, 'appointment',               'upsurge-appointment-ai',          true),
    (p_workspace_id, 'not_interested',            'upsurge-notinterested-ai',        true),
    (p_workspace_id, 'dnd',                        'upsurge-dnd-ai',                  true),
    (p_workspace_id, 'interested_no_appointment',  'upsurge-interestednoappointment-ai', false),
    (p_workspace_id, 'follow_up',                  'upsurge-followup-ai',             false)
  on conflict (workspace_id, outcome) do nothing;
end;
$$;

-- Auto-create a profile row when a new auth user signs up.
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
