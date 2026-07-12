-- Nil Patel Realty — Circle Prospecting (Ava): raise daily dial cap to 500.
-- Effective volume is still bounded by call-window length / drip_seconds.
UPDATE agent_call_configs
SET
  max_calls_per_day = 500,
  updated_at = now()
WHERE agent_id = 'fafbdf14-5a00-49e2-90ac-bb2064aa5d37'::uuid;
