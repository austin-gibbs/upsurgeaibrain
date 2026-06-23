"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Bot,
  Users,
  Tags,
  ArrowUpRight,
  CalendarClock,
  Search,
  Plus,
} from "lucide-react";
import {
  Card,
  StatusBadge,
  Badge,
  StatTile,
  SectionHeader,
  IconBadge,
  Input,
  EmptyState,
  Button,
  Label,
} from "@/components/ui";

type ContactRow = {
  id: string;
  full_name: string | null;
  phones: string[];
  attempt_count: number;
  last_called_on: string | null;
  next_eligible_on: string | null;
  is_terminal: boolean;
  terminal_outcome: string | null;
};

type OpsData = {
  workspace: {
    id: string;
    name: string;
    timezone: string;
    crm_provider: string;
    enroll_tag: string;
    is_active: boolean;
  };
  agents: {
    id: string;
    name: string;
    status: string;
    direction: string;
    objective: string | null;
    enroll_tag: string | null;
    retell_agent_id: string | null;
    agent_call_configs: {
      max_calls_per_day: number;
      max_attempts_per_contact: number;
      daily_run_at: string;
      drip_seconds: number;
    }[];
    agent_task_configs: { enabled: boolean }[];
  }[];
  contactCount: number;
  contacts: ContactRow[];
  outcomeTags: { outcome: string; tag: string; is_terminal: boolean }[];
};

const CRM_LABEL: Record<string, string> = {
  followupboss: "Follow Up Boss",
  highlevel: "HighLevel",
};

type BadgeTone = "slate" | "green" | "amber" | "red" | "blue";

function todayInTz(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${iso}T12:00:00Z`));
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

function nowHHMMInTz(timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

function formatRunTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m ?? 0).padStart(2, "0")} ${period}`;
}

function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function relativeWord(today: string, target: string): string {
  const d = daysBetween(today, target);
  if (d <= 0) return "today";
  if (d === 1) return "tomorrow";
  return `in ${d} days`;
}

function formatClock(totalSeconds: number): string {
  const h24 = Math.floor(totalSeconds / 3600) % 24;
  const m = Math.floor((totalSeconds % 3600) / 60);
  const period = h24 >= 12 ? "PM" : "AM";
  const hr = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${hr}:${String(m).padStart(2, "0")} ${period}`;
}

type Schedule = { label: string; tone: BadgeTone; note?: string };

function buildSchedules(
  contacts: ContactRow[],
  today: string,
  nowHHMM: string,
  runAt: string,
  dripSeconds: number,
  maxAttempts: number | null
): Map<string, Schedule> {
  const [rh, rm] = runAt.split(":").map(Number);
  const runStartSec = (rh || 0) * 3600 + (rm || 0) * 60;
  const perDay: Record<string, number> = {};
  const map = new Map<string, Schedule>();

  for (const c of contacts) {
    if (c.is_terminal) {
      map.set(c.id, {
        label: "Completed",
        tone: "slate",
        note: c.terminal_outcome ? c.terminal_outcome.replace(/_/g, " ") : undefined,
      });
      continue;
    }
    if (maxAttempts != null && c.attempt_count >= maxAttempts) {
      map.set(c.id, { label: "Finished", tone: "slate", note: "max attempts reached" });
      continue;
    }
    const next = c.next_eligible_on;
    const runDate =
      !next || next <= today
        ? nowHHMM < runAt
          ? today
          : addDaysIso(today, 1)
        : next;
    const pos = perDay[runDate] ?? 0;
    perDay[runDate] = pos + 1;
    const projectedSec = runStartSec + pos * dripSeconds;
    const rel = relativeWord(today, runDate);
    map.set(c.id, {
      label: `${formatDate(runDate)} · ${formatClock(projectedSec)} ET`,
      tone: runDate === today ? "green" : "blue",
      note: pos === 0 ? `${rel} · first in line` : `${rel} · ~#${pos + 1} in line`,
    });
  }
  return map;
}

export function WorkspaceOpsTab({
  data,
  workspaceId,
  onRefresh,
}: {
  data: OpsData;
  workspaceId: string;
  onRefresh: () => void;
}) {
  const [query, setQuery] = useState("");
  const [runTest, setRunTest] = useState(false);
  const [running, setRunning] = useState(false);
  const [runMessage, setRunMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const { workspace, agents, contactCount, contacts, outcomeTags } = data;

  async function runPoll() {
    setRunning(true);
    setRunMessage(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testMode: runTest }),
      });
      const d = await res.json();
      if (!res.ok) {
        setRunMessage({ type: "error", text: d.error ?? "Run failed" });
        return;
      }
      const { totals, results } = d as {
        totals: { scanned: number; eligible: number; enqueued: number };
        results: { agentName: string; skippedReason: string | null }[];
      };
      const agentCount = results.length;
      if (totals.enqueued > 0) {
        setRunMessage({
          type: "success",
          text: `Enqueued ${totals.enqueued} call${totals.enqueued === 1 ? "" : "s"} across ${agentCount} agent${agentCount === 1 ? "" : "s"} (${totals.scanned} contacts scanned)`,
        });
      } else {
        const skipped = results
          .filter((r) => r.skippedReason)
          .map((r) => `${r.agentName}: ${r.skippedReason}`)
          .join("; ");
        setRunMessage({
          type: "error",
          text: skipped
            ? `No calls enqueued. ${skipped}`
            : `No eligible contacts found (${totals.scanned} scanned)`,
        });
      }
      onRefresh();
    } catch (e) {
      setRunMessage({
        type: "error",
        text: e instanceof Error ? e.message : "Run failed",
      });
    } finally {
      setRunning(false);
    }
  }

  const today = todayInTz(workspace.timezone);
  const nowEt = nowHHMMInTz(workspace.timezone);
  const maxAttempts =
    agents.reduce(
      (m, a) => Math.max(m, a.agent_call_configs[0]?.max_attempts_per_contact ?? 0),
      0
    ) || null;
  const runAt =
    agents.reduce<string | null>((min, a) => {
      const r = a.agent_call_configs[0]?.daily_run_at;
      if (!r) return min;
      return min === null || r < min ? r : min;
    }, null) ?? "09:00";
  const dripSeconds = agents[0]?.agent_call_configs[0]?.drip_seconds ?? 60;
  const schedules = buildSchedules(
    contacts,
    today,
    nowEt,
    runAt,
    dripSeconds,
    maxAttempts
  );
  const q = query.trim().toLowerCase();
  const filteredContacts = q
    ? contacts.filter(
        (c) =>
          (c.full_name ?? "").toLowerCase().includes(q) ||
          c.phones.some((p) => p.toLowerCase().includes(q))
      )
    : contacts;
  const upcomingCount = contacts.filter(
    (c) => !c.is_terminal && !(maxAttempts != null && c.attempt_count >= maxAttempts)
  ).length;
  const activeOutboundCount = agents.filter(
    (a) => a.status === "active" && a.direction === "outbound"
  ).length;
  const canRun = workspace.is_active && activeOutboundCount > 0;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-end gap-4">
        <div className="flex flex-col items-end gap-1">
          <Label className="flex cursor-pointer items-center gap-2 font-normal text-ink-600">
            <input
              type="checkbox"
              checked={runTest}
              onChange={(e) => setRunTest(e.target.checked)}
              className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
            />
            Run Test
          </Label>
          {runTest && (
            <span className="text-xs text-ink-400">Ignores call windows for this run.</span>
          )}
        </div>
        <Button onClick={runPoll} disabled={running || !canRun}>
          {running ? "Running…" : "Run poll"}
        </Button>
        <StatusBadge status={workspace.is_active ? "active" : "paused"} />
      </div>

      {runMessage && (
        <div
          className={`mb-6 rounded-xl px-4 py-3 text-sm ${
            runMessage.type === "success"
              ? "bg-accent-mint-bg text-accent-mint-fg"
              : "bg-accent-rose-bg text-accent-rose-fg"
          }`}
        >
          {runMessage.text}
        </div>
      )}

      <div className="mb-10 grid gap-5 sm:grid-cols-3">
        <StatTile label="Agents" value={agents.length} icon={Bot} tone="sky" />
        <StatTile label="Enrolled contacts" value={contactCount} icon={Users} tone="mint" />
        <StatTile
          label="Enroll tag"
          value={<span className="font-mono text-base">{workspace.enroll_tag}</span>}
          icon={Tags}
          tone="violet"
        />
      </div>

      <SectionHeader
        title="Agents"
        action={
          <Link href={`/workspaces/${workspaceId}/agents/new`}>
            <Button variant="secondary" className="gap-1.5">
              <Plus className="h-4 w-4" />
              Add agent
            </Button>
          </Link>
        }
      />
      <div className="mb-10 grid gap-4">
        {agents.map((a) => {
          const cc = a.agent_call_configs[0];
          const tc = a.agent_task_configs[0];
          return (
            <Link key={a.id} href={`/agents/${a.id}`}>
              <Card hover className="group flex items-center justify-between p-5">
                <div className="flex items-center gap-4">
                  <IconBadge icon={Bot} tone="sky" className="h-10 w-10" />
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-ink-900">{a.name}</span>
                      <StatusBadge status={a.status} />
                      <Badge tone={a.direction === "inbound" ? "green" : "blue"}>
                        {a.direction}
                      </Badge>
                      {!a.retell_agent_id && <Badge tone="amber">no Retell ID</Badge>}
                    </div>
                    {a.objective && (
                      <p className="mt-0.5 text-sm text-ink-500">{a.objective}</p>
                    )}
                    <p className="mt-0.5 font-mono text-xs text-ink-400">
                      enroll: {a.enroll_tag ?? workspace.enroll_tag}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-right">
                  <div className="text-sm text-ink-500">
                    {cc && (
                      <span>
                        {cc.max_calls_per_day}/day · {cc.max_attempts_per_contact} attempts
                      </span>
                    )}
                    <div className="text-xs">{tc?.enabled ? "tasks on" : "no tasks"}</div>
                  </div>
                  <ArrowUpRight className="h-4 w-4 text-ink-300 transition-colors group-hover:text-brand-500" />
                </div>
              </Card>
            </Link>
          );
        })}
      </div>

      <div className="mb-10">
        <SectionHeader
          title="Call schedule"
          description={`Projected next dial times from cadence and drip settings.`}
          action={
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name or number"
                className="w-64 pl-9"
              />
            </div>
          }
        />
        {contacts.length > 0 && (
          <p className="-mt-2 mb-4 text-sm text-ink-500">
            <span className="font-medium text-ink-700">{upcomingCount}</span> upcoming ·{" "}
            <span className="font-medium text-ink-700">
              {contacts.length - upcomingCount}
            </span>{" "}
            finished
          </p>
        )}
        <Card className="overflow-hidden p-0">
          {filteredContacts.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={CalendarClock}
                title={q ? "No matching contacts" : "No enrolled contacts yet"}
                description={
                  q
                    ? "Try a different name or phone number."
                    : `Contacts tagged "${workspace.enroll_tag}" will appear after the first poll.`
                }
              />
            </div>
          ) : (
            <div className="max-h-[34rem] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-white">
                  <tr className="border-b border-ink-100 text-left text-xs font-medium uppercase tracking-wide text-ink-400">
                    <th className="px-5 py-3">Contact</th>
                    <th className="px-5 py-3">Attempts</th>
                    <th className="px-5 py-3">Last call</th>
                    <th className="px-5 py-3">Next call</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {filteredContacts.map((c) => {
                    const s = schedules.get(c.id) ?? {
                      label: "—",
                      tone: "slate" as BadgeTone,
                    };
                    return (
                      <tr key={c.id} className="transition-colors hover:bg-ink-50/50">
                        <td className="px-5 py-3.5">
                          <div className="font-medium text-ink-900">
                            {c.full_name ?? "Unknown contact"}
                          </div>
                          {c.phones[0] && (
                            <div className="font-mono text-xs text-ink-400">{c.phones[0]}</div>
                          )}
                        </td>
                        <td className="px-5 py-3.5 text-ink-600">
                          {c.attempt_count}
                          {maxAttempts != null && (
                            <span className="text-ink-400"> / {maxAttempts}</span>
                          )}
                        </td>
                        <td className="px-5 py-3.5 text-ink-600">
                          {c.last_called_on ? (
                            formatDate(c.last_called_on)
                          ) : (
                            <span className="text-ink-400">never</span>
                          )}
                        </td>
                        <td className="px-5 py-3.5">
                          <Badge tone={s.tone}>{s.label}</Badge>
                          {s.note && (
                            <div className="mt-0.5 text-xs text-ink-400">{s.note}</div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <SectionHeader
        title="Outcome taxonomy"
        description="Tags applied to contacts based on call outcomes."
      />
      <Card className="divide-y divide-ink-100 overflow-hidden p-0">
        {outcomeTags.map((t) => (
          <div
            key={t.outcome}
            className="flex items-center justify-between px-5 py-3.5 text-sm transition-colors hover:bg-ink-50/50"
          >
            <span className="font-medium text-ink-700">{t.outcome}</span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-ink-400">{t.tag}</span>
              {t.is_terminal && <Badge tone="red">terminal</Badge>}
            </div>
          </div>
        ))}
      </Card>
    </>
  );
}

export { CRM_LABEL };
