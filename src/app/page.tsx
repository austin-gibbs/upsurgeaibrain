"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Building2,
  CalendarCheck,
  DollarSign,
  Phone,
  RefreshCw,
  Target,
} from "lucide-react";
import { PageShell } from "@/components/TopNav";
import {
  Button,
  Card,
  EmptyState,
  PageGreeting,
  Segmented,
  Skeleton,
} from "@/components/ui";
import { KpiGrid } from "@/components/reporting/KpiGrid";
import { ReportingCharts } from "@/components/reporting/ReportingCharts";
import type {
  DashboardWidgetId,
  ReportingResponse,
} from "@/components/reporting/types";
import { WorkspaceTable } from "@/components/home/WorkspaceTable";
import {
  formatCost,
  formatPercent,
  type ReportingAggregates,
} from "@/lib/reporting/aggregate";
import {
  applyOverviewInterval,
  type OverviewInterval,
  type OverviewRangeDays,
  type OverviewTotals,
  type OverviewWorkspaceRow,
} from "@/lib/reporting/overview";

type OverviewResponse = {
  range: {
    days: OverviewRangeDays;
    from: string;
    to: string;
    fromYmd: string;
    toYmd: string;
  };
  interval: OverviewInterval;
  totals: OverviewTotals;
  global: ReportingAggregates;
  workspaces: OverviewWorkspaceRow[];
  referenceTimezone: string;
  meta?: {
    dataSource: "database";
    completedInRange: number;
    missingRawPayload: number;
    hint: string | null;
  };
  error?: string;
};

const HOME_WIDGETS = new Set<DashboardWidgetId>([
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
]);

function HeroMetric({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: typeof Phone;
}) {
  return (
    <div className="rounded-2xl bg-white/10 px-4 py-3 backdrop-blur-sm">
      <div className="flex items-center gap-2 text-white/70">
        <Icon className="h-3.5 w-3.5" strokeWidth={2} />
        <span className="text-[11px] font-semibold uppercase tracking-wide">
          {label}
        </span>
      </div>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight text-white">
        {value}
      </p>
    </div>
  );
}

export default function DashboardPage() {
  const [rangeDays, setRangeDays] = useState<OverviewRangeDays>(30);
  const [interval, setInterval] = useState<OverviewInterval>("weekly");
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Only re-fetch when the date range changes. Interval toggles re-bucket locally.
  const refresh = useCallback((opts?: { signal?: AbortSignal }) => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({
      range: String(rangeDays),
      interval: "daily",
    });
    return fetch(`/api/reporting/overview?${qs}`, { signal: opts?.signal })
      .then((r) => r.json())
      .then((d: OverviewResponse) => {
        if (opts?.signal?.aborted) return;
        if (d.error) {
          setError(d.error);
          setData(null);
        } else {
          setData(d);
        }
      })
      .catch((e: unknown) => {
        if (opts?.signal?.aborted) return;
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to load overview");
        setData(null);
      })
      .finally(() => {
        if (!opts?.signal?.aborted) setLoading(false);
      });
  }, [rangeDays]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh({ signal: controller.signal });
    return () => controller.abort();
  }, [refresh]);

  const chartAggregates = useMemo(() => {
    if (!data) return null;
    return applyOverviewInterval(data.global, interval);
  }, [data, interval]);

  const reportingForCharts: ReportingResponse | null = useMemo(() => {
    if (!data || !chartAggregates) return null;
    return {
      ...chartAggregates,
      workspace: {
        id: "all",
        name: "All workspaces",
        timezone: data.referenceTimezone,
        crm_provider: "all",
        crm_account_url: null,
      },
      agents: data.workspaces.flatMap((ws) =>
        ws.agents.map((a) => ({
          id: a.id,
          name: a.name,
          direction: a.direction,
          retell_agent_id: a.retell_agent_id,
          status: a.status,
        }))
      ),
      range: { from: data.range.from, to: data.range.to },
      filters: { agentId: "all", direction: "all" },
      calls: [],
      meta: data.meta
        ? {
            dataSource: "database" as const,
            completedInRange: data.meta.completedInRange,
            missingRawPayload: data.meta.missingRawPayload,
            stuckDialing: 0,
            hint: data.meta.hint,
          }
        : undefined,
    };
  }, [data, chartAggregates]);

  const workspaces = data?.workspaces ?? [];
  const totals = data?.totals;

  return (
    <PageShell nav={{ active: "workspaces", crumb: "Workspaces" }}>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <PageGreeting
          title="Command center"
          subtitle="Full Retell insights across every workspace — jump into a workspace or straight into any AI agent."
        />
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={String(rangeDays)}
            onChange={(v) => setRangeDays(Number(v) as OverviewRangeDays)}
            options={[
              { value: "7", label: "7d" },
              { value: "30", label: "30d" },
              { value: "90", label: "90d" },
            ]}
          />
          <Segmented
            value={interval}
            onChange={(v) => setInterval(v as OverviewInterval)}
            options={[
              { value: "weekly", label: "Weekly" },
              { value: "daily", label: "Daily" },
            ]}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading}
            className="gap-1.5"
          >
            <RefreshCw className={cnSpin(loading)} />
            Refresh
          </Button>
          <Link href="/setup">
            <Button size="md">+ New workspace</Button>
          </Link>
        </div>
      </div>

      {error && (
        <Card className="mb-6 p-5 text-sm text-accent-rose-fg">
          Failed to load: {error}
        </Card>
      )}

      {loading && !data && (
        <div className="space-y-5">
          <Skeleton className="h-40 w-full rounded-2xl" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-24 rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-72 w-full rounded-2xl" />
          <Skeleton className="h-64 w-full rounded-2xl" />
        </div>
      )}

      {data && totals && (
        <>
          {/* Hero total overview */}
          <div className="mb-8 overflow-hidden rounded-2xl bg-insight-gradient p-6 text-white shadow-lifted sm:p-7">
            <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
              <div className="max-w-xl">
                <p className="text-sm font-semibold text-white">Total overview</p>
                <p className="mt-1 text-sm leading-relaxed text-white/80">
                  Live Retell performance across {totals.workspaceCount} workspace
                  {totals.workspaceCount === 1 ? "" : "s"} and {totals.agentCount}{" "}
                  agent{totals.agentCount === 1 ? "" : "s"} · last {rangeDays} days
                </p>
              </div>
              <span className="rounded-full bg-white/15 px-3 py-1 text-xs font-semibold text-white backdrop-blur-sm">
                {totals.activeWorkspaceCount} active
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <HeroMetric
                label="Total calls"
                value={String(totals.totalCalls)}
                icon={Phone}
              />
              <HeroMetric
                label="Answer rate"
                value={formatPercent(totals.answerRate)}
                icon={Target}
              />
              <HeroMetric
                label="Appointments"
                value={String(totals.appointmentCount)}
                icon={CalendarCheck}
              />
              <HeroMetric
                label="Spend"
                value={formatCost(totals.totalCost)}
                icon={DollarSign}
              />
            </div>
          </div>

          {data.meta?.hint && (
            <p className="mb-6 rounded-xl bg-accent-amber-bg px-3 py-2 text-xs text-accent-amber-fg">
              {data.meta.hint}
            </p>
          )}

          {reportingForCharts && reportingForCharts.kpis.totalCalls > 0 && (
            <>
              <KpiGrid kpis={reportingForCharts.kpis} visible={HOME_WIDGETS} />
              <ReportingCharts data={reportingForCharts} visible={HOME_WIDGETS} />
            </>
          )}

          {reportingForCharts && reportingForCharts.kpis.totalCalls === 0 && workspaces.length > 0 && (
            <Card className="mb-8 p-8 text-center">
              <p className="text-sm font-medium text-ink-700">
                No completed calls in this range
              </p>
              <p className="mt-2 text-sm text-ink-500">
                Widen the date range or open a workspace to verify webhook delivery
                and agent activity.
              </p>
            </Card>
          )}

          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-ink-900">
                Workspaces
              </h2>
              <p className="mt-1 text-sm text-ink-500">
                Expand a row to jump into any AI agent without opening the workspace.
              </p>
            </div>
          </div>

          {workspaces.length === 0 ? (
            <EmptyState
              icon={Building2}
              title="No workspaces yet"
              description="Create your first workspace to connect a CRM and deploy AI voice agents."
              action={
                <Link href="/setup">
                  <Button>Create your first workspace</Button>
                </Link>
              }
            />
          ) : (
            <WorkspaceTable workspaces={workspaces} />
          )}
        </>
      )}

      {!loading && !data && !error && (
        <EmptyState
          icon={Building2}
          title="No workspaces yet"
          description="Create your first workspace to connect a CRM and deploy AI voice agents."
          action={
            <Link href="/setup">
              <Button>Create your first workspace</Button>
            </Link>
          }
        />
      )}
    </PageShell>
  );
}

function cnSpin(loading: boolean): string {
  return loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5";
}
