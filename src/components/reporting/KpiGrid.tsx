"use client";

import type { ReactNode } from "react";
import {
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  CheckCircle2,
  Voicemail,
  Target,
  CalendarCheck,
  Clock,
  DollarSign,
  Smile,
} from "lucide-react";
import { StatTile } from "@/components/ui";
import {
  formatCost,
  formatDuration,
  formatPercent,
  type ReportingKpis,
} from "@/lib/reporting/aggregate";
import type { DashboardWidgetId } from "./types";

export function KpiGrid({
  kpis,
  visible,
}: {
  kpis: ReportingKpis;
  visible: Set<DashboardWidgetId>;
}) {
  const sentimentTotal =
    kpis.sentimentPositive + kpis.sentimentNeutral + kpis.sentimentNegative;
  const positiveRate =
    sentimentTotal > 0 ? kpis.sentimentPositive / sentimentTotal : 0;

  const tiles: Array<{
    id: DashboardWidgetId;
    label: string;
    value: ReactNode;
    icon: typeof Phone;
    tone: "sky" | "mint" | "violet" | "amber" | "rose";
  }> = [
    {
      id: "kpiTotal",
      label: "Total calls",
      value: kpis.totalCalls,
      icon: Phone,
      tone: "sky",
    },
    {
      id: "kpiInbound",
      label: "Inbound",
      value: kpis.inboundCalls,
      icon: PhoneIncoming,
      tone: "mint",
    },
    {
      id: "kpiOutbound",
      label: "Outbound",
      value: kpis.outboundCalls,
      icon: PhoneOutgoing,
      tone: "violet",
    },
    {
      id: "kpiAnswerRate",
      label: "Answer rate",
      value: formatPercent(kpis.answerRate),
      icon: CheckCircle2,
      tone: "mint",
    },
    {
      id: "kpiVoicemail",
      label: "Voicemail rate",
      value: formatPercent(kpis.voicemailRate),
      icon: Voicemail,
      tone: "amber",
    },
    {
      id: "kpiSuccess",
      label: "Success rate",
      value: formatPercent(kpis.successRate),
      icon: Target,
      tone: "sky",
    },
    {
      id: "kpiAppointments",
      label: "Appointments",
      value: kpis.appointmentCount,
      icon: CalendarCheck,
      tone: "mint",
    },
    {
      id: "kpiDuration",
      label: "Avg duration",
      value: formatDuration(kpis.avgDurationSeconds),
      icon: Clock,
      tone: "violet",
    },
    {
      id: "kpiCost",
      label: "Total cost",
      value: formatCost(kpis.totalCost),
      icon: DollarSign,
      tone: "amber",
    },
    {
      id: "kpiSentiment",
      label: "Positive sentiment",
      value: formatPercent(positiveRate),
      icon: Smile,
      tone: "rose",
    },
  ];

  const shown = tiles.filter((t) => visible.has(t.id));
  if (shown.length === 0) return null;

  return (
    <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {shown.map((t) => (
        <StatTile
          key={t.id}
          label={t.label}
          value={t.value}
          icon={t.icon}
          tone={t.tone}
        />
      ))}
    </div>
  );
}
