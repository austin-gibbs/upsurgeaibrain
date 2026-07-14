"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Building2,
  ChevronDown,
  ChevronRight,
  ArrowUpRight,
  Bot,
} from "lucide-react";
import {
  Badge,
  Card,
  IconBadge,
  StatusBadge,
  cn,
} from "@/components/ui";
import {
  formatCost,
  formatPercent,
} from "@/lib/reporting/aggregate";
import type {
  OverviewAgentRow,
  OverviewWorkspaceRow,
} from "@/lib/reporting/overview";

const CRM_LABEL: Record<string, string> = {
  followupboss: "Follow Up Boss",
  highlevel: "HighLevel",
};

type SortKey = "name" | "calls" | "answerRate" | "appointments" | "cost";

function statusDot(status: string): string {
  if (status === "active") return "bg-accent-mint-icon ring-4 ring-accent-mint-bg";
  if (status === "paused") return "bg-accent-amber-icon ring-4 ring-accent-amber-bg";
  return "bg-ink-300 ring-4 ring-ink-100";
}

function SortButton({
  label,
  active,
  dir,
  onClick,
  className,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide transition-colors",
        active ? "text-brand-600" : "text-ink-400 hover:text-ink-600",
        className
      )}
    >
      {label}
      {active && (
        <span className="text-[10px]" aria-hidden>
          {dir === "asc" ? "↑" : "↓"}
        </span>
      )}
    </button>
  );
}

function AgentDropdown({
  agents,
  workspaceId,
}: {
  agents: OverviewAgentRow[];
  workspaceId: string;
}) {
  if (agents.length === 0) {
    return (
      <div className="border-t border-ink-100 bg-surface-2/60 px-5 py-4 sm:px-6">
        <p className="text-sm text-ink-500">No agents in this workspace yet.</p>
        <Link
          href={`/workspaces/${workspaceId}/agents/new`}
          className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:text-brand-700"
        >
          Add an agent
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    );
  }

  return (
    <div className="border-t border-ink-100 bg-surface-2/50 px-3 py-2 sm:px-4">
      <p className="mb-1.5 px-2 text-[10.5px] font-bold uppercase tracking-[0.07em] text-ink-400">
        AI Agents — jump in without opening the workspace
      </p>
      <ul className="space-y-0.5">
        {agents.map((agent) => (
          <li key={agent.id}>
            <Link
              href={`/agents/${agent.id}`}
              className="group flex items-center gap-3 rounded-xl px-2.5 py-2.5 transition-colors hover:bg-surface hover:shadow-soft"
            >
              <span
                className={cn("h-[7px] w-[7px] shrink-0 rounded-full", statusDot(agent.status))}
              />
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-[13px] font-semibold text-ink-800 group-hover:text-brand-700">
                  {agent.name}
                </span>
                <span className="truncate text-[11px] capitalize text-ink-400">
                  {agent.direction} · {agent.status}
                </span>
              </span>
              <span className="hidden shrink-0 rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-600 sm:inline-flex">
                {agent.calls} call{agent.calls === 1 ? "" : "s"}
              </span>
              <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-ink-300 transition-colors group-hover:text-brand-500" />
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-1 border-t border-ink-100/80 px-2 py-2">
        <Link
          href={`/workspaces/${workspaceId}`}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-500 hover:text-brand-600"
        >
          <Building2 className="h-3.5 w-3.5" />
          Open full workspace
        </Link>
      </div>
    </div>
  );
}

export function WorkspaceTable({
  workspaces,
}: {
  workspaces: OverviewWorkspaceRow[];
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [sortKey, setSortKey] = useState<SortKey>("calls");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function onSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "name" ? "asc" : "desc");
  }

  const sorted = useMemo(() => {
    const rows = [...workspaces];
    const dir = sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "name":
          cmp = a.name.localeCompare(b.name);
          break;
        case "calls":
          cmp = a.kpis.totalCalls - b.kpis.totalCalls;
          break;
        case "answerRate":
          cmp = a.kpis.answerRate - b.kpis.answerRate;
          break;
        case "appointments":
          cmp = a.kpis.appointmentCount - b.kpis.appointmentCount;
          break;
        case "cost":
          cmp = a.kpis.totalCost - b.kpis.totalCost;
          break;
      }
      if (cmp === 0) cmp = a.name.localeCompare(b.name);
      return cmp * dir;
    });
    return rows;
  }, [workspaces, sortKey, sortDir]);

  if (workspaces.length === 0) return null;

  return (
    <Card className="overflow-hidden">
      {/* Header */}
      <div className="hidden grid-cols-[minmax(0,1.6fr)_repeat(5,minmax(0,0.7fr))_minmax(5.5rem,0.55fr)] items-center gap-3 border-b border-ink-100 bg-surface-2/40 px-5 py-3 lg:grid lg:px-6">
        <SortButton
          label="Workspace"
          active={sortKey === "name"}
          dir={sortDir}
          onClick={() => onSort("name")}
        />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">
          Agents
        </span>
        <SortButton
          label="Calls"
          active={sortKey === "calls"}
          dir={sortDir}
          onClick={() => onSort("calls")}
        />
        <SortButton
          label="Answer"
          active={sortKey === "answerRate"}
          dir={sortDir}
          onClick={() => onSort("answerRate")}
        />
        <SortButton
          label="Appts"
          active={sortKey === "appointments"}
          dir={sortDir}
          onClick={() => onSort("appointments")}
        />
        <SortButton
          label="Cost"
          active={sortKey === "cost"}
          dir={sortDir}
          onClick={() => onSort("cost")}
        />
        <span className="text-right text-[11px] font-semibold uppercase tracking-wide text-ink-400">
          Status
        </span>
      </div>

      <ul>
        {sorted.map((ws, index) => {
          const isOpen = expanded.has(ws.id);
          return (
            <li
              key={ws.id}
              className={cn(
                index > 0 && "border-t border-ink-100",
                isOpen && "bg-surface"
              )}
            >
              <div className="flex items-stretch gap-0">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-label={isOpen ? "Collapse agents" : "Expand agents"}
                  onClick={() => toggleExpand(ws.id)}
                  className="flex shrink-0 items-center px-2 text-ink-400 transition-colors hover:bg-ink-50 hover:text-ink-700 sm:px-3"
                >
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4" strokeWidth={2} />
                  ) : (
                    <ChevronRight className="h-4 w-4" strokeWidth={2} />
                  )}
                </button>

                <Link
                  href={`/workspaces/${ws.id}`}
                  className="group grid min-w-0 flex-1 grid-cols-1 gap-3 px-2 py-4 transition-colors hover:bg-ink-50/60 sm:px-3 lg:grid-cols-[minmax(0,1.6fr)_repeat(5,minmax(0,0.7fr))_minmax(5.5rem,0.55fr)] lg:items-center lg:gap-3 lg:py-3.5"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <IconBadge icon={Building2} tone="sky" className="h-9 w-9" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-semibold text-ink-900 group-hover:text-brand-700">
                          {ws.name}
                        </span>
                        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-ink-300 opacity-0 transition-opacity group-hover:opacity-100 group-hover:text-brand-500" />
                      </div>
                      <p className="truncate text-xs text-ink-400">
                        {CRM_LABEL[ws.crm_provider] ?? ws.crm_provider}
                        {ws.timezone ? ` · ${ws.timezone}` : ""}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm lg:contents">
                    <div className="flex items-center gap-1.5 text-ink-600">
                      <Bot className="h-3.5 w-3.5 text-ink-400 lg:hidden" />
                      <span className="font-medium text-ink-800">
                        {ws.agentCount}
                      </span>
                      {ws.activeAgents > 0 && (
                        <span className="text-xs text-accent-mint-fg">
                          ({ws.activeAgents} active)
                        </span>
                      )}
                      <span className="text-xs text-ink-400 lg:hidden">agents</span>
                    </div>
                    <div className="lg:block">
                      <span className="text-xs text-ink-400 lg:hidden">Calls </span>
                      <span className="font-medium text-ink-800">
                        {ws.kpis.totalCalls}
                      </span>
                    </div>
                    <div className="hidden lg:block">
                      <span className="font-medium text-ink-800">
                        {formatPercent(ws.kpis.answerRate)}
                      </span>
                    </div>
                    <div className="hidden lg:block">
                      <span className="font-medium text-ink-800">
                        {ws.kpis.appointmentCount}
                      </span>
                    </div>
                    <div className="hidden lg:block">
                      <span className="font-medium text-ink-800">
                        {formatCost(ws.kpis.totalCost)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 lg:justify-end">
                      <StatusBadge status={ws.is_active ? "active" : "paused"} />
                      {ws.agents.length > 0 && (
                        <Badge tone="blue">
                          {ws.agents.length} agent{ws.agents.length === 1 ? "" : "s"}
                        </Badge>
                      )}
                    </div>
                  </div>
                </Link>
              </div>

              {isOpen && (
                <AgentDropdown agents={ws.agents} workspaceId={ws.id} />
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
