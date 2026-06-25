/** Normalize arbitrary time text to HH:MM (24h) for inputs and comparisons. */
export function normalizeHHMM(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return "09:00";
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return "09:00";
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Coerce a Supabase to-one embed (object or array) into a one-element array. */
export function normalizeEmbedList<T>(raw: T | T[] | null | undefined): T[] {
  if (Array.isArray(raw)) return raw;
  if (raw == null) return [];
  return [raw];
}

/** Normalize HH:MM fields on a single agent_call_configs row. */
export function normalizeCallConfigTimes(
  config: Record<string, unknown> | null | undefined
): Record<string, unknown> | null | undefined {
  if (!config || typeof config !== "object") return config;
  return {
    ...config,
    call_window_start:
      typeof config.call_window_start === "string"
        ? normalizeHHMM(config.call_window_start)
        : config.call_window_start,
    call_window_end:
      typeof config.call_window_end === "string"
        ? normalizeHHMM(config.call_window_end)
        : config.call_window_end,
    daily_run_at:
      typeof config.daily_run_at === "string"
        ? normalizeHHMM(config.daily_run_at)
        : config.daily_run_at,
  };
}

/** Supabase may return agent_call_configs as object or array — normalize both. */
export function normalizeCallConfigList(raw: unknown): Record<string, unknown>[] {
  return normalizeEmbedList(raw as Record<string, unknown> | Record<string, unknown>[] | null).map(
    (config) => normalizeCallConfigTimes(config) as Record<string, unknown>
  );
}


/** Normalize HH:MM fields on a single agent_task_configs row. */
export function normalizeTaskConfigTimes(
  config: Record<string, unknown> | null | undefined
): Record<string, unknown> | null | undefined {
  if (!config || typeof config !== "object") return config;
  return {
    ...config,
    due_at_time:
      typeof config.due_at_time === "string"
        ? normalizeHHMM(config.due_at_time)
        : config.due_at_time,
  };
}

/** Supabase may return agent_task_configs as object or array — normalize both. */
export function normalizeTaskConfigList(raw: unknown): Record<string, unknown>[] {
  return normalizeEmbedList(raw as Record<string, unknown> | Record<string, unknown>[] | null).map(
    (config) => normalizeTaskConfigTimes(config) as Record<string, unknown>
  );
}
