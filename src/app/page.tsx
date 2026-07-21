"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Building2,
  CalendarCheck,
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
import { readJson } from "@/lib/api/fetch-json";

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
    lean?: boolean;
    hint: string | null;
  };
  error?: string;
};

type WorkspaceShell = {
  id: string;
  name: string;
  timezone: string;
  crm_provider: string;
  is_active: boolean;
  agents: {
    id: string;
    name: string;
    status: string;
    direction?: string;
    enroll_tag?: string | null;
  }[];
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
  // Cost/sentiment need raw_payload; lean overview omits them for speed.
  "chartCallsOverTime",
  "chartDirection",
  "chartOutcomes",
  "chartHeatmap",
]);

const EMPTY_KPIS = {
  totalCalls: 0,
  inboundCalls: 0,
  outboundCalls: 0,
  answerRate: 0,
  successRate: 0,
  appointmentCount: 0,
  avgDurationSeconds: 0,
  totalCost: 0,
  sentimentPositive: 0,
} as const;

function shellToOverviewRows(shell: WorkspaceShell[]): OverviewWorkspaceRow[] {
  return shell.map((ws) => ({
    id: ws.id,
    name: ws.name,
    timezone: ws.timezone,
    crm_provider: ws.crm_provider,
    is_active: ws.is_active,
    agentCount: ws.agents.length,
    activeAgents: ws.agents.filter((a) => a.status === "active").length,
    agents: ws.agents.map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
      direction: a.direction ?? "outbound",
      retell_agent_id: null,
      calls: 0,
    })),
    kpis: { ...EMPTY_KPIS },
  }));
}

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
  const [workspaceShell, setWorkspaceShell] = useState<OverviewWorkspaceRow[] | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [loadingReporting, setLoadingReporting] = useState(true);

  // Instant shell: workspaces + agents (no call aggregates).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/workspaces")
      .then((r) => readJson<{ workspaces?: WorkspaceShell[]; error?: string }>(r))
      .then((d) => {
        if (cancelled || d.error || !d.workspaces) return;
        setWorkspaceShell(shellToOverviewRows(d.workspaces));
      })
      .catch(() => {
        /* reporting path still loads workspaces */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(
    (opts?: { signal?: AbortSignal }) => {
      setLoadingReporting(true);
      setError(null);
      const qs = new URLSearchParams({
        range: String(rangeDays),
        interval: "daily",
      });
      return fetch(`/api/reporting/overview?${qs}`, { signal: opts?.signal })
        .then((r) => readJson<OverviewResponse>(r))
        .then((d) => {
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
          if (!opts?.signal?.aborted) setLoadingReporting(false);
        });
    },
    [rangeDays]
  );

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

  // Prefer enriched overview rows; fall back to instant shell.
  const workspaces = data?.workspaces ?? workspaceShell ?? [];
  const totals = data?.totals;
  const shellOnly = !data && workspaceShell !== null;

  return (
    <PageShell nav={{ active: "home", crumb: "Home" }}>
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
            disabled={loadingReporting}
            className="gap-1.5"
          >
            <RefreshCw className={cnSpin(loadingReporting)} />
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

      {/* Hero / KPIs — skeleton until reporting lands */}
      {loadingReporting && !data ? (
        <div className="mb-8 space-y-5">
          <Skeleton className="h-40 w-full rounded-2xl" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-24 rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-72 w-full rounded-2xl" />
        </div>
      ) : null}

      {data && totals && (
        <>
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
                label="Workspaces"
                value={String(totals.workspaceCount)}
                icon={Building2}
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

          {reportingForCharts &&
            reportingForCharts.kpis.totalCalls === 0 &&
            workspaces.length > 0 && (
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
        </>
      )}

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-ink-900">
            Workspaces
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            Expand a row to jump into any AI agent without opening the workspace.
            {shellOnly ? " Loading call stats…" : ""}
          </p>
        </div>
      </div>

      {workspaceShell === null && !data && !error ? (
        <Skeleton className="h-64 w-full rounded-2xl" />
      ) : workspaces.length === 0 && !loadingReporting ? (
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
      ) : workspaces.length > 0 ? (
        <WorkspaceTable workspaces={workspaces} />
      ) : null}
    </PageShell>
  );
}

function cnSpin(loading: boolean): string {
  return loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5";
}
