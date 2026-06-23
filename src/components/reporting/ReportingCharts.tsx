"use client";

import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, SectionHeader } from "@/components/ui";
import { DAY_LABELS } from "@/lib/reporting/aggregate";
import type { ReportingResponse, DashboardWidgetId } from "./types";

const CHART_COLORS = {
  inbound: "#0ea5e9",
  outbound: "#8b5cf6",
  total: "#2563eb",
  mint: "#10b981",
  amber: "#f59e0b",
  rose: "#f43f5e",
  slate: "#64748b",
};

const PIE_COLORS = ["#2563eb", "#10b981", "#f59e0b", "#f43f5e", "#8b5cf6", "#64748b"];

function ChartCard({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={`p-5 ${className ?? ""}`}>
      <SectionHeader title={title} description={description} />
      <div className="mt-4 h-64">{children}</div>
    </Card>
  );
}

export function ReportingCharts({
  data,
  visible,
}: {
  data: ReportingResponse;
  visible: Set<DashboardWidgetId>;
}) {
  const directionData = [
    { name: "Inbound", value: data.kpis.inboundCalls, fill: CHART_COLORS.inbound },
    { name: "Outbound", value: data.kpis.outboundCalls, fill: CHART_COLORS.outbound },
  ];

  const heatmapMax = Math.max(...data.heatmap.map((h) => h.count), 1);

  return (
    <div className="mb-10 grid gap-5 lg:grid-cols-2">
      {visible.has("chartCallsOverTime") && (
        <ChartCard
          title="Calls over time"
          description="Daily inbound and outbound volume"
          className="lg:col-span-2"
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.callsOverTime}>
              <defs>
                <linearGradient id="inboundGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_COLORS.inbound} stopOpacity={0.35} />
                  <stop offset="95%" stopColor={CHART_COLORS.inbound} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="outboundGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_COLORS.outbound} stopOpacity={0.35} />
                  <stop offset="95%" stopColor={CHART_COLORS.outbound} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Area
                type="monotone"
                dataKey="inbound"
                stroke={CHART_COLORS.inbound}
                fill="url(#inboundGrad)"
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="outbound"
                stroke={CHART_COLORS.outbound}
                fill="url(#outboundGrad)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {visible.has("chartDirection") && (
        <ChartCard title="Inbound vs outbound" description="Call direction split">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={directionData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={55}
                outerRadius={90}
                paddingAngle={3}
              >
                {directionData.map((entry, i) => (
                  <Cell key={entry.name} fill={entry.fill ?? PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {visible.has("chartOutcomes") && data.outcomeBreakdown.length > 0 && (
        <ChartCard title="Outcomes" description="Call result distribution">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.outcomeBreakdown.slice(0, 8)} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
              <YAxis
                type="category"
                dataKey="outcome"
                width={100}
                tick={{ fontSize: 10 }}
              />
              <Tooltip />
              <Bar dataKey="count" fill={CHART_COLORS.total} radius={[0, 6, 6, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {visible.has("chartSentiment") && data.sentimentBreakdown.length > 0 && (
        <ChartCard title="Sentiment" description="Caller sentiment from Retell analysis">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data.sentimentBreakdown}
                dataKey="count"
                nameKey="sentiment"
                cx="50%"
                cy="50%"
                outerRadius={90}
              >
                {data.sentimentBreakdown.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {visible.has("chartHeatmap") && (
        <ChartCard
          title="Peak call times"
          description="Hour × day-of-week heatmap"
          className="lg:col-span-2"
        >
          <div className="h-full overflow-x-auto">
            <div className="min-w-[640px]">
              <div className="mb-2 grid grid-cols-[2.5rem_repeat(24,minmax(0,1fr))] gap-0.5 text-[10px] text-ink-400">
                <div />
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="text-center">
                    {h % 3 === 0 ? `${h}` : ""}
                  </div>
                ))}
              </div>
              {DAY_LABELS.map((day, dow) => (
                <div
                  key={day}
                  className="mb-0.5 grid grid-cols-[2.5rem_repeat(24,minmax(0,1fr))] gap-0.5"
                >
                  <div className="flex items-center text-[10px] font-medium text-ink-500">
                    {day}
                  </div>
                  {Array.from({ length: 24 }, (_, hour) => {
                    const cell = data.heatmap.find(
                      (h) => h.dayOfWeek === dow && h.hour === hour
                    );
                    const count = cell?.count ?? 0;
                    const intensity = count / heatmapMax;
                    return (
                      <div
                        key={hour}
                        title={`${day} ${hour}:00 — ${count} calls`}
                        className="aspect-square rounded-sm"
                        style={{
                          backgroundColor:
                            count === 0
                              ? "#f1f5f9"
                              : `rgba(37, 99, 235, ${0.15 + intensity * 0.85})`,
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </ChartCard>
      )}

      {visible.has("chartLatency") && data.latencyOverTime.length > 0 && (
        <ChartCard
          title="End-to-end latency"
          description="Daily p50 and p90 (ms)"
          className="lg:col-span-2"
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.latencyOverTime}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Line
                type="monotone"
                dataKey="p50Ms"
                name="p50"
                stroke={CHART_COLORS.inbound}
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="p90Ms"
                name="p90"
                stroke={CHART_COLORS.outbound}
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {visible.has("chartDisconnection") && data.disconnectionBreakdown.length > 0 && (
        <ChartCard
          title="Disconnection reasons"
          description="Top reasons calls ended"
          className="lg:col-span-2"
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.disconnectionBreakdown}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="reason" tick={{ fontSize: 10 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="count" fill={CHART_COLORS.amber} radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}
    </div>
  );
}
