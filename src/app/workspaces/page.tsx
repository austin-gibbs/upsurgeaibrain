"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Building2, Search, X } from "lucide-react";
import { PageShell } from "@/components/TopNav";
import {
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  PageGreeting,
  Segmented,
  Select,
  Skeleton,
} from "@/components/ui";
import {
  CRM_LABEL,
  WorkspaceTable,
} from "@/components/home/WorkspaceTable";
import type {
  OverviewInterval,
  OverviewRangeDays,
  OverviewWorkspaceRow,
} from "@/lib/reporting/overview";
import type { ReportingAggregates } from "@/lib/reporting/aggregate";

type OverviewResponse = {
  range: { days: OverviewRangeDays };
  interval: OverviewInterval;
  global: ReportingAggregates;
  workspaces: OverviewWorkspaceRow[];
  error?: string;
};

type StatusFilter = "all" | "active" | "paused";
type CrmFilter = "all" | "followupboss" | "highlevel";

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

type WorkspaceApiRow = {
  id: string;
  name: string;
  timezone: string;
  crm_provider: string;
  enroll_tag: string;
  is_active: boolean;
  agents: { id: string; name: string; status: string; direction?: string }[];
};

function shellRows(api: WorkspaceApiRow[]): OverviewWorkspaceRow[] {
  return api.map((ws) => ({
    id: ws.id,
    name: ws.name,
    timezone: ws.timezone,
    crm_provider: ws.crm_provider,
    is_active: ws.is_active,
    enroll_tag: ws.enroll_tag,
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

export default function WorkspacesListPage() {
  const [workspaces, setWorkspaces] = useState<OverviewWorkspaceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [crmFilter, setCrmFilter] = useState<CrmFilter>("all");

  const [pendingDelete, setPendingDelete] = useState<OverviewWorkspaceRow | null>(
    null
  );
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      // Shell first (fast), then enrich with lean overview KPIs.
      const shellRes = await fetch("/api/workspaces", { signal });
      const shellJson = await shellRes.json();
      if (signal?.aborted) return;
      if (shellJson.error) throw new Error(shellJson.error);
      const shell = shellRows((shellJson.workspaces ?? []) as WorkspaceApiRow[]);
      setWorkspaces(shell);
      setLoading(false);

      const qs = new URLSearchParams({ range: "30", interval: "daily" });
      const overviewRes = await fetch(`/api/reporting/overview?${qs}`, { signal });
      const overviewJson = (await overviewRes.json()) as OverviewResponse;
      if (signal?.aborted) return;
      if (overviewJson.error) {
        // Keep shell table; KPIs just stay at zero.
        return;
      }

      const byId = new Map(shell.map((w) => [w.id, w]));
      setWorkspaces(
        overviewJson.workspaces.map((ws) => ({
          ...ws,
          enroll_tag: ws.enroll_tag ?? byId.get(ws.id)?.enroll_tag ?? null,
        }))
      );
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Failed to load workspaces");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const filtered = useMemo(() => {
    if (!workspaces) return [];
    const q = search.trim().toLowerCase();
    return workspaces.filter((ws) => {
      if (statusFilter === "active" && !ws.is_active) return false;
      if (statusFilter === "paused" && ws.is_active) return false;
      if (crmFilter !== "all" && ws.crm_provider !== crmFilter) return false;
      if (!q) return true;
      const haystack = [
        ws.name,
        ws.crm_provider,
        CRM_LABEL[ws.crm_provider] ?? "",
        ws.timezone,
        ws.enroll_tag ?? "",
        ...ws.agents.map((a) => a.name),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [workspaces, search, statusFilter, crmFilter]);

  const hasActiveFilters =
    search.trim() !== "" || statusFilter !== "all" || crmFilter !== "all";

  function clearFilters() {
    setSearch("");
    setStatusFilter("all");
    setCrmFilter("all");
  }

  function openDelete(ws: OverviewWorkspaceRow) {
    setPendingDelete(ws);
    setDeleteConfirmName("");
    setDeleteError(null);
  }

  function closeDelete() {
    if (deleting) return;
    setPendingDelete(null);
    setDeleteConfirmName("");
    setDeleteError(null);
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    if (deleteConfirmName.trim() !== pendingDelete.name) {
      setDeleteError("Type the workspace name exactly to confirm deletion.");
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/workspaces/${pendingDelete.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmName: deleteConfirmName.trim() }),
      });
      const d = await res.json();
      if (!res.ok) {
        setDeleteError(d.error ?? "Failed to delete workspace");
        return;
      }
      setWorkspaces((prev) =>
        (prev ?? []).filter((w) => w.id !== pendingDelete.id)
      );
      setPendingDelete(null);
      setDeleteConfirmName("");
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Failed to delete workspace");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <PageShell nav={{ active: "workspaces", crumb: "Workspaces" }}>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <PageGreeting
          title="Workspaces"
          subtitle="Search, filter, and open any workspace — or jump straight into an AI agent."
        />
        <Link href="/setup">
          <Button size="lg">+ New workspace</Button>
        </Link>
      </div>

      {error && (
        <Card className="mb-6 p-5 text-sm text-accent-rose-fg">
          Failed to load: {error}
        </Card>
      )}

      <Card className="mb-6 p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1 space-y-1.5">
            <Label htmlFor="workspace-search">Search</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
              <Input
                id="workspace-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Name, CRM, agent, enroll tag…"
                className="pl-9"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Status</Label>
            <Segmented
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as StatusFilter)}
              options={[
                { value: "all", label: "All" },
                { value: "active", label: "Active" },
                { value: "paused", label: "Paused" },
              ]}
            />
          </div>
          <div className="min-w-[160px] space-y-1.5">
            <Label htmlFor="crm-filter">CRM</Label>
            <Select
              id="crm-filter"
              value={crmFilter}
              onChange={(e) => setCrmFilter(e.target.value as CrmFilter)}
            >
              <option value="all">All CRMs</option>
              <option value="followupboss">Follow Up Boss</option>
              <option value="highlevel">HighLevel</option>
            </Select>
          </div>
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="gap-1.5">
              <X className="h-3.5 w-3.5" />
              Clear
            </Button>
          )}
        </div>
        {workspaces && (
          <p className="mt-3 text-xs text-ink-400">
            Showing {filtered.length} of {workspaces.length} workspace
            {workspaces.length === 1 ? "" : "s"}
          </p>
        )}
      </Card>

      {loading && !workspaces && (
        <Skeleton className="h-64 w-full rounded-2xl" />
      )}

      {workspaces && workspaces.length === 0 && (
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

      {workspaces && workspaces.length > 0 && filtered.length === 0 && (
        <EmptyState
          icon={Search}
          title="No matching workspaces"
          description="Try a different search or clear your filters."
          action={
            <Button variant="secondary" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      )}

      {filtered.length > 0 && (
        <WorkspaceTable
          workspaces={filtered}
          onDeleteWorkspace={openDelete}
        />
      )}

      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-workspace-title"
          onClick={closeDelete}
        >
          <Card
            className="w-full max-w-md border-accent-rose-fg/20 p-6 shadow-lifted"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="delete-workspace-title"
              className="text-lg font-semibold text-ink-900"
            >
              Delete workspace
            </h2>
            <p className="mt-2 text-sm text-ink-500">
              Permanently removes{" "}
              <span className="font-medium text-ink-800">{pendingDelete.name}</span>
              , all agents, contacts, call history, and queue entries. Retell agents
              and phone numbers are not deleted automatically.
            </p>
            <div className="mt-5 space-y-3">
              <Label htmlFor="delete-confirm">
                Type{" "}
                <span className="font-medium text-ink-800">{pendingDelete.name}</span>{" "}
                to confirm
              </Label>
              <Input
                id="delete-confirm"
                value={deleteConfirmName}
                onChange={(e) => {
                  setDeleteConfirmName(e.target.value);
                  setDeleteError(null);
                }}
                placeholder={pendingDelete.name}
                autoComplete="off"
                autoFocus
              />
              {deleteError && (
                <div className="rounded-xl bg-accent-rose-bg px-4 py-3 text-sm text-accent-rose-fg">
                  {deleteError}
                </div>
              )}
              <div className="flex flex-wrap justify-end gap-2 pt-1">
                <Button variant="secondary" onClick={closeDelete} disabled={deleting}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  disabled={
                    deleting || deleteConfirmName.trim() !== pendingDelete.name
                  }
                  onClick={() => void confirmDelete()}
                >
                  {deleting ? "Deleting…" : "Delete permanently"}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </PageShell>
  );
}
