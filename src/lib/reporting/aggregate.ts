// =====================================================================
// Pure reporting aggregation over normalized Retell call rows.
// Unit-testable — no I/O.
// =====================================================================
import type { AgentDirection } from "@/types";

export interface NormalizedCallRow {
  retellCallId: string;
  agentId: string | null;
  agentName: string | null;
  direction: AgentDirection;
  startTimestamp: number | null;
  completedAt: string | null;
  durationSeconds: number;
  fromNumber: string | null;
  toNumber: string | null;
  phone: string | null;
  contactName: string | null;
  contactEmail: string | null;
  crmContactId: string | null;
  recordingUrl: string | null;
  summary: string | null;
  outcome: string | null;
  callSuccessful: boolean | null;
  userSentiment: string | null;
  inVoicemail: boolean;
  disconnectionReason: string | null;
  cost: number;
  latencyP50Ms: number | null;
  latencyP90Ms: number | null;
}

export interface ReportingKpis {
  totalCalls: number;
  inboundCalls: number;
  outboundCalls: number;
  connectedCalls: number;
  answerRate: number;
  voicemailRate: number;
  successRate: number;
  appointmentCount: number;
  avgDurationSeconds: number;
  totalDurationSeconds: number;
  totalCost: number;
  avgCost: number;
  sentimentPositive: number;
  sentimentNeutral: number;
  sentimentNegative: number;
  latencyP50Ms: number | null;
  latencyP90Ms: number | null;
}

export interface TimeSeriesPoint {
  date: string;
  inbound: number;
  outbound: number;
  total: number;
}

export interface OutcomeBreakdown {
  outcome: string;
  count: number;
}

export interface SentimentBreakdown {
  sentiment: string;
  count: number;
}

export interface DisconnectionBreakdown {
  reason: string;
  count: number;
}

export interface HeatmapCell {
  dayOfWeek: number;
  hour: number;
  count: number;
}

export interface LatencyPoint {
  date: string;
  p50Ms: number;
  p90Ms: number;
}

export interface ReportingAggregates {
  kpis: ReportingKpis;
  callsOverTime: TimeSeriesPoint[];
  outcomeBreakdown: OutcomeBreakdown[];
  sentimentBreakdown: SentimentBreakdown[];
  disconnectionBreakdown: DisconnectionBreakdown[];
  heatmap: HeatmapCell[];
  latencyOverTime: LatencyPoint[];
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function isoDateFromMs(ms: number | null, timezone = "America/New_York"): string {
  if (!ms) return "unknown";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

function hourInTz(ms: number, timezone = "America/New_York"): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date(ms));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "0";
  return Number(hour) % 24;
}

function dayOfWeekInTz(ms: number, timezone = "America/New_York"): number {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(new Date(ms));
  return DAY_NAMES.indexOf(weekday);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function normalizeSentiment(raw: string | null): "positive" | "neutral" | "negative" | "unknown" {
  if (!raw) return "unknown";
  const s = raw.toLowerCase();
  if (s.includes("positive") || s === "happy") return "positive";
  if (s.includes("negative") || s === "unhappy" || s === "angry") return "negative";
  if (s.includes("neutral")) return "neutral";
  return "unknown";
}

function isConnected(row: NormalizedCallRow): boolean {
  if (row.durationSeconds > 0) return true;
  const reason = (row.disconnectionReason ?? "").toLowerCase();
  return !reason.includes("no_answer") && !reason.includes("not_connected");
}

export function aggregateReporting(
  calls: NormalizedCallRow[],
  timezone = "America/New_York"
): ReportingAggregates {
  const inbound = calls.filter((c) => c.direction === "inbound");
  const outbound = calls.filter((c) => c.direction === "outbound");
  const connected = calls.filter(isConnected);
  const voicemails = calls.filter((c) => c.inVoicemail);
  const successful = calls.filter((c) => c.callSuccessful === true);
  const appointments = calls.filter(
    (c) => c.outcome === "appointment" || (c.outcome ?? "").includes("appointment")
  );

  const totalDuration = calls.reduce((s, c) => s + c.durationSeconds, 0);
  const totalCost = calls.reduce((s, c) => s + c.cost, 0);
  const latencyP50s = calls.map((c) => c.latencyP50Ms).filter((v): v is number => v != null);
  const latencyP90s = calls.map((c) => c.latencyP90Ms).filter((v): v is number => v != null);

  const sentimentCounts = { positive: 0, neutral: 0, negative: 0, unknown: 0 };
  for (const c of calls) {
    const bucket = normalizeSentiment(c.userSentiment);
    if (bucket === "unknown") sentimentCounts.unknown++;
    else sentimentCounts[bucket]++;
  }

  const kpis: ReportingKpis = {
    totalCalls: calls.length,
    inboundCalls: inbound.length,
    outboundCalls: outbound.length,
    connectedCalls: connected.length,
    answerRate: calls.length ? connected.length / calls.length : 0,
    voicemailRate: calls.length ? voicemails.length / calls.length : 0,
    successRate: calls.length ? successful.length / calls.length : 0,
    appointmentCount: appointments.length,
    avgDurationSeconds: calls.length ? totalDuration / calls.length : 0,
    totalDurationSeconds: totalDuration,
    totalCost,
    avgCost: calls.length ? totalCost / calls.length : 0,
    sentimentPositive: sentimentCounts.positive,
    sentimentNeutral: sentimentCounts.neutral,
    sentimentNegative: sentimentCounts.negative,
    latencyP50Ms: percentile(latencyP50s, 50),
    latencyP90Ms: percentile(latencyP90s, 90),
  };

  // Calls over time
  const byDate = new Map<string, { inbound: number; outbound: number }>();
  for (const c of calls) {
    const date = isoDateFromMs(c.startTimestamp, timezone);
    const entry = byDate.get(date) ?? { inbound: 0, outbound: 0 };
    if (c.direction === "inbound") entry.inbound++;
    else entry.outbound++;
    byDate.set(date, entry);
  }
  const callsOverTime: TimeSeriesPoint[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({
      date,
      inbound: v.inbound,
      outbound: v.outbound,
      total: v.inbound + v.outbound,
    }));

  // Outcome breakdown
  const outcomeMap = new Map<string, number>();
  for (const c of calls) {
    const key = c.outcome ?? (c.inVoicemail ? "voicemail" : "unknown");
    outcomeMap.set(key, (outcomeMap.get(key) ?? 0) + 1);
  }
  const outcomeBreakdown: OutcomeBreakdown[] = [...outcomeMap.entries()]
    .map(([outcome, count]) => ({ outcome, count }))
    .sort((a, b) => b.count - a.count);

  // Sentiment breakdown
  const sentimentMap = new Map<string, number>();
  for (const c of calls) {
    const key = normalizeSentiment(c.userSentiment);
    sentimentMap.set(key, (sentimentMap.get(key) ?? 0) + 1);
  }
  const sentimentBreakdown: SentimentBreakdown[] = [...sentimentMap.entries()].map(
    ([sentiment, count]) => ({ sentiment, count })
  );

  // Disconnection reasons
  const discMap = new Map<string, number>();
  for (const c of calls) {
    const key = c.disconnectionReason ?? "unknown";
    discMap.set(key, (discMap.get(key) ?? 0) + 1);
  }
  const disconnectionBreakdown: DisconnectionBreakdown[] = [...discMap.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Heatmap: day x hour
  const heatmapMap = new Map<string, number>();
  for (const c of calls) {
    if (!c.startTimestamp) continue;
    const dow = dayOfWeekInTz(c.startTimestamp, timezone);
    const hour = hourInTz(c.startTimestamp, timezone);
    const key = `${dow}:${hour}`;
    heatmapMap.set(key, (heatmapMap.get(key) ?? 0) + 1);
  }
  const heatmap: HeatmapCell[] = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      heatmap.push({
        dayOfWeek: dow,
        hour,
        count: heatmapMap.get(`${dow}:${hour}`) ?? 0,
      });
    }
  }

  // Latency over time (daily avg p50/p90)
  const latencyByDate = new Map<string, { p50: number[]; p90: number[] }>();
  for (const c of calls) {
    if (!c.startTimestamp) continue;
    const date = isoDateFromMs(c.startTimestamp, timezone);
    const entry = latencyByDate.get(date) ?? { p50: [], p90: [] };
    if (c.latencyP50Ms != null) entry.p50.push(c.latencyP50Ms);
    if (c.latencyP90Ms != null) entry.p90.push(c.latencyP90Ms);
    latencyByDate.set(date, entry);
  }
  const latencyOverTime: LatencyPoint[] = [...latencyByDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({
      date,
      p50Ms: percentile(v.p50, 50) ?? 0,
      p90Ms: percentile(v.p90, 90) ?? 0,
    }));

  return {
    kpis,
    callsOverTime,
    outcomeBreakdown,
    sentimentBreakdown,
    disconnectionBreakdown,
    heatmap,
    latencyOverTime,
  };
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function formatCost(dollars: number): string {
  return `$${dollars.toFixed(2)}`;
}

export const DAY_LABELS = DAY_NAMES;

export const HEATMAP_HOURS = Array.from({ length: 24 }, (_, i) => i);
