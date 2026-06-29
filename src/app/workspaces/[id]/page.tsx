"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";
import { PageShell, type PageNav } from "@/components/TopNav";
import {
  Button,
  Card,
  Input,
  Label,
  PageGreeting,
  Segmented,
  Select,
  Skeleton,
} from "@/components/ui";
import { KpiGrid } from "@/components/reporting/KpiGrid";
import { ReportingCharts } from "@/components/reporting/ReportingCharts";
import { CallLog } from "@/components/reporting/CallLog";
import {
  DEFAULT_WIDGETS,
  WIDGET_LABELS,
  type DashboardWidgetId,
  type ReportingResponse,
} from "@/components/reporting/types";
import { WorkspaceOpsTab, CRM_LABEL } from "@/components/workspace/WorkspaceOpsTab";

type OpsDetail = {
  workspace: {
    id: string;
    name: string;
    timezone: string;
    crm_provider: string;
    crm_account_url?: string | null;
    crm_status?: string | null;
    enroll_tag: string;
    is_active: boolean;
    has_workspace_crm_credentials?: boolean;
  };
  agents: Parameters<typeof WorkspaceOpsTab>[0]["data"]["agents"];
  contactCount: number;
  contacts: Parameters<typeof WorkspaceOpsTab>[0]["data"]["contacts"];
  outcomeTags: Parameters<typeof WorkspaceOpsTab>[0]["data"]["outcomeTags"];
};

type SummaryDetail = {
  workspace: OpsDetail["workspace"];
  agents: OpsDetail["agents"];
  contactCount: number;
  tasksEnabled: boolean;
};

function defaultFromDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadWidgets(workspaceId: string): Set<DashboardWidgetId> {
  if (typeof window === "undefined") return new Set(DEFAULT_WIDGETS);
  try {
    const raw = localStorage.getItem(`upsurge-dashboard-widgets-${workspaceId}`);
    if (!raw) return new Set(DEFAULT_WIDGETS);
    const parsed = JSON.parse(raw) as DashboardWidgetId[];
    return new Set(parsed.length ? parsed : DEFAULT_WIDGETS);
  } catch {
    return new Set(DEFAULT_WIDGETS);
  }
}

export default function WorkspaceDetailPage({
  params,
}: {
  params: { id: string };
}) {
  return (
    <Suspense fallback={null}>
      <WorkspaceDetail params={params} />
    </Suspense>
  );
}

function WorkspaceDetail({ params }: { params: { id: string } }) {
  const searchParams = useSearchParams();
  const tab: "dashboard" | "operations" =
    searchParams.get("tab") === "operations" ? "operations" : "dashboard";
  const [summary, setSummary] = useState<SummaryDetail | null>(null);
  const [opsData, setOpsData] = useState<OpsDetail | null>(null);
  const [reporting, setReporting] = useState<ReportingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingReporting, setLoadingReporting] = useState(true);
  const [loadingOps, setLoadingOps] = useState(false);

  const [agentId, setAgentId] = useState("all");
  const [direction, setDirection] = useState<"all" | "inbound" | "outbound">("all");
  const [fromDate, setFromDate] = useState(defaultFromDate);
  const [toDate, setToDate] = useState(todayDate);
  const [widgets, setWidgets] = useState<Set<DashboardWidgetId>>(() =>
    loadWidgets(params.id)
  );
  const [showCustomize, setShowCustomize] = useState(false);
  const [crmAccountUrl, setCrmAccountUrl] = useState("");
  const [savingUrl, setSavingUrl] = useState(false);

  const refreshSummary = useCallback(() => {
    fetch(`/api/workspaces/${params.id}/summary`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else {
          setSummary(d);
          setCrmAccountUrl(d.workspace.crm_account_url ?? "");
        }
      })
      .catch((e) => setError(e.message));
  }, [params.id]);

  const refreshOps = useCallback(() => {
    setLoadingOps(true);
    fetch(`/api/workspaces/${params.id}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else {
          setOpsData(d);
          setSummary((prev) =>
            prev
              ? {
                  ...prev,
                  workspace: {
                    ...prev.workspace,
                    ...d.workspace,
                  },
                  agents: d.agents,
                  contactCount: d.contactCount,
                }
              : {
                  workspace: d.workspace,
                  agents: d.agents,
                  contactCount: d.contactCount,
                  tasksEnabled: false,
                }
          );
          setCrmAccountUrl(d.workspace.crm_account_url ?? "");
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoadingOps(false));
  }, [params.id]);

  const fetchReporting = useCallback(() => {
    setLoadingReporting(true);
    const qs = new URLSearchParams({
      agentId,
      direction,
      from: fromDate,
      to: toDate,
    });
    fetch(`/api/workspaces/${params.id}/reporting?${qs}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setReporting(d);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoadingReporting(false));
  }, [params.id, agentId, direction, fromDate, toDate]);

  useEffect(() => {
    refreshSummary();
  }, [refreshSummary]);

  useEffect(() => {
    if (tab === "operations" && !opsData && !loadingOps) {
      refreshOps();
    }
  }, [tab, opsData, loadingOps, refreshOps]);

  useEffect(() => {
    if (tab === "dashboard") fetchReporting();
  }, [tab, fetchReporting]);

  useEffect(() => {
    localStorage.setItem(
      `upsurge-dashboard-widgets-${params.id}`,
      JSON.stringify([...widgets])
    );
  }, [widgets, params.id]);

  function toggleWidget(id: DashboardWidgetId) {
    setWidgets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function saveCrmUrl() {
    setSavingUrl(true);
    try {
      const res = await fetch(`/api/workspaces/${params.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ crm_account_url: crmAccountUrl.trim() || null }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Failed to save");
      refreshSummary();
      if (opsData) refreshOps();
      fetchReporting();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save CRM URL");
    } finally {
      setSavingUrl(false);
    }
  }

  const selectedAgent = useMemo(
    () => reporting?.agents.find((a) => a.id === agentId),
    [reporting, agentId]
  );

  const crumb = tab === "operations" ? "Operations" : "Dashboard";
  const header = summary ?? opsData;

  if (error && !header) {
    return (
      <PageShell nav={{ workspaceId: params.id, active: tab, crumb }}>
        <Card className="p-5 text-sm text-accent-rose-fg">{error}</Card>
      </PageShell>
    );
  }

  if (!header) {
    return (
      <PageShell nav={{ workspaceId: params.id, active: tab, crumb }}>
        <Skeleton className="mb-4 h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </PageShell>
    );
  }

  if (tab === "operations" && !opsData) {
    return (
      <PageShell
        nav={{
          workspaceId: params.id,
          workspaceName: header.workspace.name,
          workspaceMeta: `${CRM_LABEL[header.workspace.crm_provider]} · ${header.workspace.timezone}`,
          agents: header.agents.map((a) => ({
            id: a.id,
            name: a.name,
            status: a.status,
            direction: a.direction,
          })),
          active: tab,
          crumb,
        }}
      >
        <Skeleton className="mb-4 h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </PageShell>
    );
  }

  const { workspace } = header;

  const nav: PageNav = {
    workspaceId: params.id,
    workspaceName: workspace.name,
    workspaceMeta: `${CRM_LABEL[workspace.crm_provider]} · ${workspace.timezone}`,
    agents: header.agents.map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
      direction: a.direction,
    })),
    active: tab,
    crumb,
  };

  return (
    <PageShell nav={nav}>
      {tab === "dashboard" && (
        <>
          <PageGreeting
            title="Dashboard"
            subtitle="Reporting across every agent in this workspace."
          />
          <Card className="mb-6 space-y-4 p-5">
            <div className="flex flex-wrap items-end gap-4">
              <div className="min-w-[180px] flex-1 space-y-1.5">
                <Label>Agent</Label>
                <Select
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                >
                  <option value="all">All agents</option>
                  {(reporting?.agents ?? header.agents).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.direction})
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Direction</Label>
                <Segmented
                  value={direction}
                  onChange={(v) => setDirection(v as typeof direction)}
                  options={[
                    { value: "all", label: "All" },
                    { value: "inbound", label: "Inbound" },
                    { value: "outbound", label: "Outbound" },
                  ]}
                />
              </div>
              <div className="space-y-1.5">
                <Label>From</Label>
                <Input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="w-40"
                />
              </div>
              <div className="space-y-1.5">
                <Label>To</Label>
                <Input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="w-40"
                />
              </div>
              <Button variant="secondary" onClick={fetchReporting} disabled={loadingReporting}>
                {loadingReporting ? "Loading…" : "Refresh"}
              </Button>
              <Button
                variant="ghost"
                className="gap-1.5"
                onClick={() => setShowCustomize((s) => !s)}
              >
                <SlidersHorizontal className="h-4 w-4" />
                Customize
              </Button>
            </div>

            {reporting?.meta?.hint && (
              <p className="rounded-xl bg-accent-amber-bg px-3 py-2 text-xs text-accent-amber-fg">
                {reporting.meta.hint}
              </p>
            )}

            {selectedAgent && agentId !== "all" && (
              <p className="text-sm text-ink-500">
                Showing reporting for{" "}
                <span className="font-medium text-ink-700">{selectedAgent.name}</span>{" "}
                ({selectedAgent.direction} · Retell {selectedAgent.retell_agent_id ?? "—"})
              </p>
            )}

            {workspace.crm_provider === "followupboss" && !workspace.crm_account_url && (
              <div className="rounded-xl border border-ink-200/50 bg-accent-amber-bg p-4">
                <Label hint="enables View in CRM links">
                  Follow Up Boss account URL
                </Label>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Input
                    value={crmAccountUrl}
                    onChange={(e) => setCrmAccountUrl(e.target.value)}
                    placeholder="https://nilpatel.followupboss.com"
                    className="max-w-md flex-1"
                  />
                  <Button onClick={saveCrmUrl} disabled={savingUrl} size="sm">
                    {savingUrl ? "Saving…" : "Save"}
                  </Button>
                </div>
              </div>
            )}

            {showCustomize && (
              <div className="rounded-xl border border-ink-200/50 bg-ink-50/50 p-4">
                <p className="mb-3 text-sm font-medium text-ink-700">
                  Toggle report containers
                </p>
                <div className="flex flex-wrap gap-2">
                  {(Object.keys(WIDGET_LABELS) as DashboardWidgetId[]).map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => toggleWidget(id)}
                      className={`rounded-xl border px-3 py-1.5 text-xs font-medium transition-all ${
                        widgets.has(id)
                          ? "border-brand-500 bg-accent-sky-bg text-accent-sky-fg"
                          : "border-ink-200/80 bg-surface text-ink-500"
                      }`}
                    >
                      {WIDGET_LABELS[id]}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Card>

          {loadingReporting && !reporting ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-24 rounded-2xl" />
                ))}
              </div>
              <Skeleton className="h-72 rounded-2xl" />
            </div>
          ) : reporting && reporting.kpis.totalCalls === 0 ? (
            <Card className="p-8 text-center">
              <p className="text-sm font-medium text-ink-700">No completed calls in this range</p>
              <p className="mt-2 text-sm text-ink-500">
                Calls appear here after Retell webhooks finalize them as completed.
                If you expect traffic, check webhook health in Admin → Diagnostics
                or widen the date range.
              </p>
            </Card>
          ) : reporting ? (
            <>
              <KpiGrid kpis={reporting.kpis} visible={widgets} />
              <ReportingCharts data={reporting} visible={widgets} />
              {widgets.has("callLog") && (
                <CallLog
                  calls={reporting.calls}
                  agents={reporting.agents}
                  crmProvider={reporting.workspace.crm_provider}
                />
              )}
            </>
          ) : null}
          {error && reporting && (
            <p className="mt-4 rounded-xl bg-accent-rose-bg px-4 py-2.5 text-sm text-accent-rose-fg">
              {error}
            </p>
          )}
        </>
      )}

      {tab === "operations" && opsData && (
        <WorkspaceOpsTab
          data={opsData}
          workspaceId={params.id}
          onRefresh={() => {
            refreshSummary();
            refreshOps();
          }}
        />
      )}
    </PageShell>
  );
}
