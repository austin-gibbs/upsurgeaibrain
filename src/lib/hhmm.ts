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
