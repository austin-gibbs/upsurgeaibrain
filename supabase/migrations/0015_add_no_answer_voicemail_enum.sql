-- Add combined outcome enum value (must commit before use in updates).
alter type call_outcome add value if not exists 'no_answer_voicemail';
