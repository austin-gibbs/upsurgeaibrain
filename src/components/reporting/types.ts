import type {
  NormalizedCallRow,
  ReportingAggregates,
  ReportingKpis,
} from "@/lib/reporting/aggregate";

export type ReportingAgent = {
  id: string;
  name: string;
  direction: string;
  retell_agent_id: string | null;
  status: string;
};

export type ReportingResponse = ReportingAggregates & {
  workspace: {
    id: string;
    name: string;
    timezone: string;
    crm_provider: string;
    crm_account_url: string | null;
  };
  agents: ReportingAgent[];
  range: { from: string; to: string };
  filters: { agentId: string; direction: string };
  retellErrors?: string[];
  calls: (NormalizedCallRow & { crmUrl: string | null })[];
};

export type DashboardWidgetId =
  | "kpiTotal"
  | "kpiInbound"
  | "kpiOutbound"
  | "kpiAnswerRate"
  | "kpiVoicemail"
  | "kpiSuccess"
  | "kpiAppointments"
  | "kpiDuration"
  | "kpiCost"
  | "kpiSentiment"
  | "chartCallsOverTime"
  | "chartDirection"
  | "chartOutcomes"
  | "chartSentiment"
  | "chartHeatmap"
  | "chartLatency"
  | "chartDisconnection"
  | "callLog";

export const DEFAULT_WIDGETS: DashboardWidgetId[] = [
  "kpiTotal",
  "kpiInbound",
  "kpiOutbound",
  "kpiAnswerRate",
  "kpiVoicemail",
  "kpiSuccess",
  "kpiAppointments",
  "kpiDuration",
  "kpiCost",
  "kpiSentiment",
  "chartCallsOverTime",
  "chartDirection",
  "chartOutcomes",
  "chartSentiment",
  "chartHeatmap",
  "chartLatency",
  "chartDisconnection",
  "callLog",
];

export const WIDGET_LABELS: Record<DashboardWidgetId, string> = {
  kpiTotal: "Total calls",
  kpiInbound: "Inbound calls",
  kpiOutbound: "Outbound calls",
  kpiAnswerRate: "Answer rate",
  kpiVoicemail: "Voicemail rate",
  kpiSuccess: "Success rate",
  kpiAppointments: "Appointments",
  kpiDuration: "Avg duration",
  kpiCost: "Total cost",
  kpiSentiment: "Positive sentiment",
  chartCallsOverTime: "Calls over time",
  chartDirection: "Inbound vs outbound",
  chartOutcomes: "Outcome breakdown",
  chartSentiment: "Sentiment split",
  chartHeatmap: "Peak call times",
  chartLatency: "Latency trend",
  chartDisconnection: "Disconnection reasons",
  callLog: "Call log",
};

export type { ReportingKpis };
