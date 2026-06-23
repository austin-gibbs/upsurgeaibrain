"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Bot,
  Users,
  Tags,
  ArrowUpRight,
  CalendarClock,
  Search,
  Plus,
  Phone,
  ListOrdered,
  Loader2,
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
  Select,
} from "@/components/ui";
import { dailyWindowCapacity, hhmmToSeconds } from "@/lib/engine/cadence";

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
      call_window_start: string;
      call_window_end: string;
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

function formatTime(iso: string | null, timezone: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function formatClock(totalSeconds: number): string {
  const h24 = Math.floor(totalSeconds / 3600) % 24;
  const m = Math.floor((totalSeconds % 3600) / 60);
  const period = h24 >= 12 ? "PM" : "AM";
  const hr = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${hr}:${String(m).padStart(2, "0")} ${period}`;
}

type Schedule = { label: string; tone: BadgeTone; note?: string };

type QueueEntry = {
  id: string;
  agentId: string;
  agentName: string;
  contactId: string;
  contactName: string;
  phone: string | null;
  status: "pending" | "dialing";
  position: number;
  scheduledFor: string | null;
  enqueuedAt: string;
  startedAt: string | null;
};

type QueueSummary = { total: number; pending: number; dialing: number };

function buildSchedules(
  contacts: ContactRow[],
  today: string,
  nowHHMM: string,
  windowStart: string,
  windowEnd: string,
  dripSeconds: number,
  maxCallsPerDay: number,
  maxAttempts: number | null
): Map<string, Schedule> {
  const dailyCap = Math.min(
    maxCallsPerDay,
    dailyWindowCapacity(windowStart, windowEnd, dripSeconds)
  );
  const windowStartSec = hhmmToSeconds(windowStart);
  const perDay: Record<string, number> = {};
  const map = new Map<string, Schedule>();

  const sorted = [...contacts].sort((a, b) => {
    if (a.is_terminal !== b.is_terminal) return a.is_terminal ? 1 : -1;
    const na = a.next_eligible_on ?? "0000-00-00";
    const nb = b.next_eligible_on ?? "0000-00-00";
    if (na !== nb) return na.localeCompare(nb);
    return a.attempt_count - b.attempt_count;
  });

  function findRunDate(earliest: string): string {
    let d = earliest;
    for (;;) {
      const count = perDay[d] ?? 0;
      if (count < dailyCap) return d;
      d = addDaysIso(d, 1);
    }
  }

  for (const c of sorted) {
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
    let earliest: string;
    if (next && next > today) {
      earliest = next;
    } else if (nowHHMM > windowEnd) {
      earliest = addDaysIso(today, 1);
    } else {
      earliest = today;
    }

    const runDate = findRunDate(earliest);
    const pos = perDay[runDate] ?? 0;
    perDay[runDate] = pos + 1;
    const projectedSec = windowStartSec + pos * dripSeconds;
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
  const [callingId, setCallingId] = useState<string | null>(null);
  const [testNumber, setTestNumber] = useState("");
  const [placingTest, setPlacingTest] = useState(false);
  const [testMessage, setTestMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [queuing, setQueuing] = useState(false);
  const [queueEntries, setQueueEntries] = useState<QueueEntry[]>([]);
  const [queueSummary, setQueueSummary] = useState<QueueSummary>({
    total: 0,
    pending: 0,
    dialing: 0,
  });
  const [queueLoading, setQueueLoading] = useState(true);

  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/queue-calls`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        entries: QueueEntry[];
        summary: QueueSummary;
      };
      setQueueEntries(data.entries ?? []);
      setQueueSummary(
        data.summary ?? { total: 0, pending: 0, dialing: 0 }
      );
    } catch {
      /* keep last good snapshot */
    } finally {
      setQueueLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchQueue();
    const timer = setInterval(fetchQueue, 10_000);
    return () => clearInterval(timer);
  }, [fetchQueue]);

  const { workspace, agents, contactCount, contacts, outcomeTags } = data;

  // Outbound agents that are wired up to Retell can place a manual test call.
  const callableAgents = agents.filter(
    (a) => a.direction === "outbound" && a.retell_agent_id
  );
  const [testAgentId, setTestAgentId] = useState<string>("");
  const activeTestAgentId = testAgentId || callableAgents[0]?.id || "";

  async function placeAdHocTestCall() {
    const agentId = activeTestAgentId;
    if (!agentId) {
      setTestMessage({
        type: "error",
        text: "No outbound agent with a Retell ID is available.",
      });
      return;
    }
    setPlacingTest(true);
    setTestMessage(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/test-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, toNumber: testNumber.trim() }),
      });
      const d = await res.json();
      if (!res.ok) {
        setTestMessage({
          type: "error",
          text:
            d.issues?.[0]?.message ?? d.error ?? "Test call failed",
        });
        return;
      }
      setTestMessage({
        type: "success",
        text: `Calling ${d.toNumber} now — it should ring within a few seconds. This call is isolated from the live queue.`,
      });
      onRefresh();
    } catch (e) {
      setTestMessage({
        type: "error",
        text: e instanceof Error ? e.message : "Test call failed",
      });
    } finally {
      setPlacingTest(false);
    }
  }

  async function queueSelected() {
    const agentId = activeTestAgentId;
    if (!agentId) {
      setRunMessage({
        type: "error",
        text: "No outbound agent with a Retell ID is available to queue calls.",
      });
      return;
    }
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setQueuing(true);
    setRunMessage(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/queue-calls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, contactIds: ids }),
      });
      const d = await res.json();
      if (!res.ok) {
        setRunMessage({ type: "error", text: d.error ?? "Failed to queue calls" });
        return;
      }
      if (d.enqueued > 0) {
        setRunMessage({
          type: "success",
          text: `Queued ${d.enqueued} call${d.enqueued === 1 ? "" : "s"} now, ${
            d.enqueued === 1 ? "" : "60s apart, "
          }starting immediately.${
            d.capped > 0
              ? ` ${d.capped} didn't fit before the call window closes and were skipped — re-queue them tomorrow.`
              : ""
          }`,
        });
        setSelectedIds(new Set());
      } else {
        setRunMessage({
          type: "error",
          text: d.skippedReason
            ? `No calls queued — ${d.skippedReason}.`
            : "No eligible contacts to queue (terminal or no phone number).",
        });
      }
      onRefresh();
      await fetchQueue();
    } catch (e) {
      setRunMessage({
        type: "error",
        text: e instanceof Error ? e.message : "Failed to queue calls",
      });
    } finally {
      setQueuing(false);
    }
  }

  async function callNow(contactId: string) {
    const agentId = activeTestAgentId;
    if (!agentId) {
      setRunMessage({
        type: "error",
        text: "No outbound agent with a Retell ID is available to place a test call.",
      });
      return;
    }
    setCallingId(contactId);
    setRunMessage(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/test-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, contactId }),
      });
      const d = await res.json();
      if (!res.ok) {
        setRunMessage({ type: "error", text: d.error ?? "Test call failed" });
        return;
      }
      setRunMessage({
        type: "success",
        text: `Calling ${d.contactName ?? "contact"} now at ${d.toNumber} — full CRM write-back runs after the call.${
          d.cancelledQueued > 0
            ? ` Removed ${d.cancelledQueued} pending scheduled dial${d.cancelledQueued === 1 ? "" : "s"} for this contact to avoid a double call.`
            : ""
        } The rest of the call queue is untouched.`,
      });
      onRefresh();
    } catch (e) {
      setRunMessage({
        type: "error",
        text: e instanceof Error ? e.message : "Test call failed",
      });
    } finally {
      setCallingId(null);
    }
  }

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
      await fetchQueue();
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
  const outboundConfig =
    agents.find((a) => a.direction === "outbound")?.agent_call_configs[0] ??
    agents[0]?.agent_call_configs[0];
  const windowStart = outboundConfig?.call_window_start ?? "09:00";
  const windowEnd = outboundConfig?.call_window_end ?? "18:00";
  const dripSeconds = outboundConfig?.drip_seconds ?? 60;
  const maxCallsPerDay = outboundConfig?.max_calls_per_day ?? 100;
  const schedules = buildSchedules(
    contacts,
    today,
    nowEt,
    windowStart,
    windowEnd,
    dripSeconds,
    maxCallsPerDay,
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
  const isSelectable = (c: ContactRow) => !c.is_terminal && Boolean(c.phones[0]);
  const selectableFiltered = filteredContacts.filter(isSelectable);
  const allFilteredSelected =
    selectableFiltered.length > 0 &&
    selectableFiltered.every((c) => selectedIds.has(c.id));

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => {
      if (allFilteredSelected) {
        const next = new Set(prev);
        selectableFiltered.forEach((c) => next.delete(c.id));
        return next;
      }
      const next = new Set(prev);
      selectableFiltered.forEach((c) => next.add(c.id));
      return next;
    });
  }

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

      <div className="mb-10">
        <SectionHeader
          title="Test call"
          description="Dial any phone number right now to check an outbound agent. Runs instantly, ignores call windows, and is fully isolated from the live call queue and your CRM."
        />
        <Card className="p-5">
          {callableAgents.length === 0 ? (
            <EmptyState
              icon={Phone}
              title="No callable agent"
              description="Add an outbound agent with a Retell agent ID and from number to place test calls."
            />
          ) : (
            <>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
                {callableAgents.length > 1 && (
                  <div className="sm:w-56">
                    <Label htmlFor="test-agent">Agent</Label>
                    <Select
                      id="test-agent"
                      value={activeTestAgentId}
                      onChange={(e) => setTestAgentId(e.target.value)}
                    >
                      {callableAgents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                )}
                <div className="flex-1">
                  <Label htmlFor="test-number">Phone number</Label>
                  <Input
                    id="test-number"
                    value={testNumber}
                    onChange={(e) => setTestNumber(e.target.value)}
                    placeholder="+15551234567"
                    inputMode="tel"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && testNumber.trim() && !placingTest) {
                        placeAdHocTestCall();
                      }
                    }}
                  />
                  <p className="mt-1 text-xs text-ink-400">
                    E.164 format with country code, e.g. +15551234567
                  </p>
                </div>
                <Button
                  onClick={placeAdHocTestCall}
                  disabled={placingTest || testNumber.trim().length === 0}
                  className="gap-1.5"
                >
                  <Phone className="h-4 w-4" />
                  {placingTest ? "Calling…" : "Place test call"}
                </Button>
              </div>
              {testMessage && (
                <div
                  className={`mt-4 rounded-xl px-4 py-3 text-sm ${
                    testMessage.type === "success"
                      ? "bg-accent-mint-bg text-accent-mint-fg"
                      : "bg-accent-rose-bg text-accent-rose-fg"
                  }`}
                >
                  {testMessage.text}
                </div>
              )}
            </>
          )}
        </Card>
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
          title="Call queue"
          description="Live queue of contacts waiting to dial or currently on a call. Contacts appear here when enqueued and are removed automatically after the call finishes and CRM write-back completes."
          action={
            <Button variant="ghost" size="sm" onClick={fetchQueue} disabled={queueLoading}>
              Refresh
            </Button>
          }
        />
        <Card className="overflow-hidden p-0">
          {queueLoading && queueEntries.length === 0 ? (
            <div className="flex items-center justify-center gap-2 p-8 text-sm text-ink-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading queue…
            </div>
          ) : queueEntries.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={ListOrdered}
                title="Queue is empty"
                description='Select contacts below and click "Queue calls now", or run a poll to fill the queue.'
              />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3 border-b border-ink-100 bg-ink-50/50 px-5 py-3 text-sm text-ink-600">
                <span>
                  <span className="font-semibold text-ink-900">{queueSummary.total}</span>{" "}
                  in queue
                </span>
                <span className="text-ink-300">·</span>
                <span>
                  {queueSummary.pending} waiting
                </span>
                <span className="text-ink-300">·</span>
                <span>
                  {queueSummary.dialing} on call
                </span>
              </div>
              <div className="max-h-80 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-white">
                    <tr className="border-b border-ink-100 text-left text-xs font-medium uppercase tracking-wide text-ink-400">
                      <th className="px-5 py-3 w-12">#</th>
                      <th className="px-5 py-3">Contact</th>
                      <th className="px-5 py-3">Agent</th>
                      <th className="px-5 py-3">Status</th>
                      <th className="px-5 py-3">Scheduled</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {queueEntries.map((entry) => (
                      <tr key={entry.id} className="transition-colors hover:bg-ink-50/50">
                        <td className="px-5 py-3.5 font-mono text-xs text-ink-400">
                          {entry.position}
                        </td>
                        <td className="px-5 py-3.5">
                          <div className="font-medium text-ink-900">{entry.contactName}</div>
                          {entry.phone && (
                            <div className="font-mono text-xs text-ink-400">{entry.phone}</div>
                          )}
                        </td>
                        <td className="px-5 py-3.5 text-ink-600">{entry.agentName}</td>
                        <td className="px-5 py-3.5">
                          <Badge tone={entry.status === "dialing" ? "amber" : "blue"}>
                            {entry.status === "dialing" ? "On call" : "Waiting"}
                          </Badge>
                        </td>
                        <td className="px-5 py-3.5 text-ink-600">
                          {entry.status === "dialing"
                            ? formatTime(entry.startedAt, workspace.timezone)
                            : formatTime(entry.scheduledFor, workspace.timezone)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      </div>

      <div className="mb-10">
        <SectionHeader
          title="Call schedule"
          description={`Projected next dial times from cadence and drip settings. Use "Call now" to dial a contact immediately for testing, ignoring call windows and cadence.`}
          action={
            <div className="flex items-center gap-3">
              {callableAgents.length > 1 && (
                <Select
                  value={activeTestAgentId}
                  onChange={(e) => setTestAgentId(e.target.value)}
                  className="w-44"
                  aria-label="Agent for test calls"
                >
                  {callableAgents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              )}
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search name or number"
                  className="w-64 pl-9"
                />
              </div>
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
        {selectedIds.size > 0 && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-200/50 bg-white px-4 py-3 shadow-card">
            <span className="text-sm font-medium text-ink-700">
              {selectedIds.size} contact{selectedIds.size === 1 ? "" : "s"} selected
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedIds(new Set())}
                disabled={queuing}
              >
                Clear
              </Button>
              <Button
                size="sm"
                className="gap-1.5"
                disabled={queuing || callableAgents.length === 0}
                title={
                  callableAgents.length === 0
                    ? "No outbound agent with a Retell ID"
                    : "Queue the selected contacts into the call sequence now, 60s apart"
                }
                onClick={queueSelected}
              >
                <Phone className="h-3.5 w-3.5" />
                {queuing ? "Queuing…" : "Queue calls now"}
              </Button>
            </div>
          </div>
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
                    <th className="w-10 px-5 py-3">
                      <input
                        type="checkbox"
                        checked={allFilteredSelected}
                        onChange={toggleSelectAll}
                        disabled={selectableFiltered.length === 0}
                        aria-label="Select all contacts"
                        className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                      />
                    </th>
                    <th className="px-5 py-3">Contact</th>
                    <th className="px-5 py-3">Attempts</th>
                    <th className="px-5 py-3">Last call</th>
                    <th className="px-5 py-3">Next call</th>
                    <th className="px-5 py-3 text-right">Test</th>
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
                          <input
                            type="checkbox"
                            checked={selectedIds.has(c.id)}
                            onChange={() => toggleSelected(c.id)}
                            disabled={!isSelectable(c)}
                            aria-label={`Select ${c.full_name ?? "contact"}`}
                            title={
                              c.is_terminal
                                ? "Contact has completed the flow"
                                : !c.phones[0]
                                  ? "Contact has no phone number"
                                  : "Select to bulk-queue"
                            }
                            className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500 disabled:opacity-40"
                          />
                        </td>
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
                        <td className="px-5 py-3.5 text-right">
                          <Button
                            variant="secondary"
                            size="sm"
                            className="gap-1.5"
                            disabled={
                              c.is_terminal ||
                              !c.phones[0] ||
                              callableAgents.length === 0 ||
                              callingId !== null
                            }
                            title={
                              callableAgents.length === 0
                                ? "No outbound agent with a Retell ID"
                                : c.is_terminal
                                  ? "Contact has completed the flow"
                                  : !c.phones[0]
                                    ? "Contact has no phone number"
                                    : "Dial this contact now (ignores call windows)"
                            }
                            onClick={() => callNow(c.id)}
                          >
                            <Phone className="h-3.5 w-3.5" />
                            {callingId === c.id ? "Calling…" : "Call now"}
                          </Button>
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
