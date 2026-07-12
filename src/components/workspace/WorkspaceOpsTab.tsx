"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
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
  Copy,
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
  SubTabs,
} from "@/components/ui";
import { dailyWindowCapacity } from "@/lib/engine/cadence";
import {
  contactHasEnrollTag,
  effectiveEnrollTag,
  enrollTagConflict,
  suggestDuplicateEnrollTag,
} from "@/lib/agents/enroll-tag";
import {
  loadPersistedOpsAgent,
  pickDefaultOpsAgentId,
  savePersistedOpsAgent,
} from "@/lib/workspaces/ops-agent-scope";

type ContactRow = {
  id: string;
  full_name: string | null;
  phones: string[];
  tags: string[];
  attempt_count: number;
  last_called_on: string | null;
  next_eligible_on: string | null;
  is_terminal: boolean;
  terminal_outcome: string | null;
};

type AgentCallConfigRow = {
  max_calls_per_day: number;
  max_attempts_per_contact: number;
  daily_run_at: string;
  call_window_start: string;
  call_window_end: string;
  drip_seconds: number;
};

type OpsData = {
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
  agents: {
    id: string;
    name: string;
    status: string;
    direction: string;
    objective: string | null;
    enroll_tag: string | null;
    retell_agent_id: string | null;
    agent_call_configs: AgentCallConfigRow | AgentCallConfigRow[];
    agent_task_configs: { enabled: boolean } | { enabled: boolean }[];
  }[];
  contactCount: number;
  contacts: ContactRow[];
  outcomeTags: { outcome: string; tag: string; is_terminal: boolean }[];
  pollRuns?: {
    id: string;
    agent_id: string;
    ran_at: string;
    scanned: number;
    eligible: number;
    enqueued: number;
    cancelled: number;
    tags_stripped: number;
    trigger_source: string;
    skipped_reason: string | null;
    test_mode: boolean;
  }[];
};

const CRM_LABEL: Record<string, string> = {
  followupboss: "Follow Up Boss",
  highlevel: "HighLevel",
};

type BadgeTone = "slate" | "green" | "amber" | "red" | "blue";

function firstEmbed<T>(embed: T | T[] | null | undefined): T | undefined {
  if (Array.isArray(embed)) return embed[0];
  if (embed && typeof embed === "object") return embed;
  return undefined;
}

function timezoneAbbrev(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "short",
    }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? timezone;
  } catch {
    return timezone;
  }
}

function firstCallConfig(agents: OpsData["agents"]): AgentCallConfigRow | undefined {
  const outbound = agents.find((a) => a.direction === "outbound");
  return firstEmbed(outbound?.agent_call_configs) ?? firstEmbed(agents[0]?.agent_call_configs);
}

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

function formatDateTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function formatScheduledDisplay(iso: string | null, timezone: string): string {
  if (!iso) return "—";
  return formatTime(iso, timezone);
}

function hhmmToSeconds(hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return h * 3600 + m * 60;
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
  phoneIndex?: number;
  phoneCount?: number;
  phoneProgress?: string | null;
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
  maxAttempts: number | null,
  tzLabel: string
): Map<string, Schedule> {
  const dailyCap = Math.min(
    maxCallsPerDay,
    dailyWindowCapacity(windowStart, windowEnd, dripSeconds)
  );
  const windowStartSec = hhmmToSeconds(windowStart);
  const windowEndSec = hhmmToSeconds(windowEnd);
  const nowSec = hhmmToSeconds(nowHHMM);
  const perDay: Record<string, number> = {};
  const map = new Map<string, Schedule>();

  const sorted = [...contacts].sort((a, b) => {
    if (a.is_terminal !== b.is_terminal) return a.is_terminal ? 1 : -1;
    const na = a.next_eligible_on ?? "0000-00-00";
    const nb = b.next_eligible_on ?? "0000-00-00";
    if (na !== nb) return na.localeCompare(nb);
    return a.attempt_count - b.attempt_count;
  });

  function capacityForDate(date: string): number {
    if (date !== today) return dailyCap;
    if (nowSec > windowEndSec) return 0;
    const firstSlotSec = Math.max(nowSec, windowStartSec);
    const remainingSeconds = windowEndSec - firstSlotSec;
    if (remainingSeconds < 0 || dripSeconds <= 0) return 0;
    return Math.min(maxCallsPerDay, Math.floor(remainingSeconds / dripSeconds) + 1);
  }

  function findRunDate(earliest: string): string {
    let d = earliest;
    for (;;) {
      const cap = capacityForDate(d);
      const count = perDay[d] ?? 0;
      if (cap > 0 && count < cap) return d;
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
    const dayStartSec =
      runDate === today ? Math.max(nowSec, windowStartSec) : windowStartSec;
    const projectedSec = dayStartSec + pos * dripSeconds;
    perDay[runDate] = pos + 1;
    const rel = relativeWord(today, runDate);
    map.set(c.id, {
      label: `${formatDate(runDate)} · ${formatClock(projectedSec)} ${tzLabel}`,
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
  return (
    <Suspense fallback={null}>
      <WorkspaceOpsTabInner data={data} workspaceId={workspaceId} onRefresh={onRefresh} />
    </Suspense>
  );
}

function WorkspaceOpsTabInner({
  data,
  workspaceId,
  onRefresh,
}: {
  data: OpsData;
  workspaceId: string;
  onRefresh: () => void;
}) {
  const searchParams = useSearchParams();
  const [opsTab, setOpsTab] = useState<
    "overview" | "queue" | "schedule" | "outcomes"
  >("overview");
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
  const [queueByAgent, setQueueByAgent] = useState<Record<string, number>>({});
  const [queueLoading, setQueueLoading] = useState(true);
  const [opsAgentId, setOpsAgentId] = useState("");
  const [opsAgentReady, setOpsAgentReady] = useState(false);
  const [testAgentId, setTestAgentId] = useState<string>("");
  const [duplicateSource, setDuplicateSource] = useState<OpsData["agents"][number] | null>(
    null
  );
  const [duplicateName, setDuplicateName] = useState("");
  const [duplicateEnrollTag, setDuplicateEnrollTag] = useState("");
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [controlMsg, setControlMsg] = useState<string | null>(null);
  const [savingControl, setSavingControl] = useState(false);

  const router = useRouter();

  const { workspace, agents, contactCount, contacts, outcomeTags, pollRuns = [] } = data;

  useEffect(() => {
    const crm = searchParams.get("crm");
    if (crm === "connected") {
      setControlMsg("HighLevel connected at workspace level — all inheriting agents share this token.");
      onRefresh();
    } else if (crm === "error") {
      const reason = searchParams.get("reason");
      setControlMsg(
        reason
          ? `HighLevel connection failed: ${reason}`
          : "HighLevel connection was cancelled or failed."
      );
    }
  }, [searchParams, onRefresh]);

  const tasksEnabled =
    agents.length > 0 &&
    agents.every((a) => Boolean(firstEmbed(a.agent_task_configs)?.enabled));

  async function patchWorkspace(body: Record<string, unknown>) {
    setSavingControl(true);
    setControlMsg(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Failed to update workspace");
      onRefresh();
      setControlMsg("Workspace settings saved.");
    } catch (e) {
      setControlMsg(e instanceof Error ? e.message : "Failed to update workspace");
    } finally {
      setSavingControl(false);
    }
  }

  const agentEnrollRows = agents.map((a) => ({
    id: a.id,
    direction: a.direction as "inbound" | "outbound",
    enroll_tag: a.enroll_tag,
  }));

  const outboundAgents = agents.filter((a) => a.direction === "outbound");
  const selectedOpsAgent =
    outboundAgents.find((a) => a.id === opsAgentId) ??
    (opsAgentReady ? outboundAgents[0] ?? null : null);
  const selectedEnrollTag = selectedOpsAgent
    ? effectiveEnrollTag(selectedOpsAgent.enroll_tag, workspace.enroll_tag)
    : workspace.enroll_tag;

  // Prefer persisted scope, else the outbound agent with the most queued
  // contacts (then most enrolled) so a populated queue isn't hidden behind
  // the oldest active agent in multi-outbound workspaces.
  useEffect(() => {
    if (opsAgentReady || outboundAgents.length === 0) return;

    const persisted = loadPersistedOpsAgent(workspaceId);
    if (persisted && outboundAgents.some((a) => a.id === persisted)) {
      setOpsAgentId(persisted);
      setOpsAgentReady(true);
      return;
    }

    // Wait for the first queue fetch so byAgent can rank populated agents.
    if (queueLoading) return;

    const bestId = pickDefaultOpsAgentId(
      outboundAgents,
      workspace.enroll_tag,
      contacts,
      queueByAgent
    );
    if (bestId) {
      setOpsAgentId(bestId);
      setOpsAgentReady(true);
    }
  }, [
    opsAgentReady,
    outboundAgents,
    workspaceId,
    workspace.enroll_tag,
    contacts,
    queueLoading,
    queueByAgent,
  ]);

  const fetchQueue = useCallback(async () => {
    try {
      const qs = opsAgentId ? `?agentId=${opsAgentId}` : "";
      const res = await fetch(`/api/workspaces/${workspaceId}/queue-calls${qs}`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        entries: QueueEntry[];
        summary: QueueSummary;
        byAgent?: Record<string, number>;
      };
      setQueueEntries(data.entries ?? []);
      setQueueSummary(
        data.summary ?? { total: 0, pending: 0, dialing: 0 }
      );
      if (data.byAgent) setQueueByAgent(data.byAgent);
    } catch {
      /* keep last good snapshot */
    } finally {
      setQueueLoading(false);
    }
  }, [workspaceId, opsAgentId]);

  useEffect(() => {
    fetchQueue();
    const timer = setInterval(fetchQueue, 10_000);
    return () => clearInterval(timer);
  }, [fetchQueue]);

  // Outbound agents that are wired up to Retell can place a manual test call.
  const callableAgents = agents.filter(
    (a) => a.direction === "outbound" && a.retell_agent_id
  );
  const activeTestAgentId =
    testAgentId || opsAgentId || callableAgents[0]?.id || "";

  function setOpsAgent(nextId: string) {
    setOpsAgentId(nextId);
    setTestAgentId(nextId);
    setSelectedIds(new Set());
    setOpsAgentReady(true);
    savePersistedOpsAgent(workspaceId, nextId);
  }

  function closeDuplicateDialog() {
    setDuplicateSource(null);
    setDuplicateName("");
    setDuplicateEnrollTag("");
    setDuplicateError(null);
  }

  function openDuplicateDialog(agent: OpsData["agents"][number]) {
    setDuplicateSource(agent);
    setDuplicateName(`Copy of ${agent.name}`);
    if (agent.direction === "outbound") {
      setDuplicateEnrollTag(
        suggestDuplicateEnrollTag(agent.enroll_tag, workspace.enroll_tag, agentEnrollRows)
      );
    } else {
      setDuplicateEnrollTag("");
    }
    setDuplicateError(null);
  }

  function duplicateEnrollTagValidation(tag: string): string | null {
    if (!duplicateSource || duplicateSource.direction !== "outbound") return null;
    const trimmed = tag.trim();
    if (!trimmed) return "Enrollment tag is required.";
    if (enrollTagConflict(trimmed, workspace.enroll_tag, agentEnrollRows)) {
      return "An agent in this workspace already uses this enrollment tag.";
    }
    return null;
  }

  async function submitDuplicate() {
    if (!duplicateSource) return;
    const name = duplicateName.trim();
    if (!name) {
      setDuplicateError("Agent name is required.");
      return;
    }
    const tagErr = duplicateEnrollTagValidation(duplicateEnrollTag);
    if (tagErr) {
      setDuplicateError(tagErr);
      return;
    }

    setDuplicating(true);
    setDuplicateError(null);
    try {
      const res = await fetch(`/api/agents/${duplicateSource.id}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          enroll_tag:
            duplicateSource.direction === "outbound" ? duplicateEnrollTag.trim() : null,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        agentId?: string;
      };
      if (!res.ok) {
        setDuplicateError(payload.error ?? "Failed to duplicate agent.");
        return;
      }
      closeDuplicateDialog();
      if (payload.agentId) {
        router.push(`/agents/${payload.agentId}`);
      } else {
        onRefresh();
      }
    } catch {
      setDuplicateError("Network error while duplicating agent.");
    } finally {
      setDuplicating(false);
    }
  }

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
          text: `Queued ${d.enqueued} of ${d.requested ?? ids.length} contact${
            (d.requested ?? ids.length) === 1 ? "" : "s"
          }${d.enqueued > 1 ? ", drip-spaced" : ""}.${
            d.capped > 0
              ? ` ${d.capped} skipped (terminal or no phone number).`
              : ""
          }${
            d.errors?.length
              ? ` ${d.errors.length} issue${d.errors.length === 1 ? "" : "s"}: ${d.errors.join("; ")}`
              : ""
          }`,
        });
        setSelectedIds(new Set());
      } else {
        setRunMessage({
          type: "error",
          text: d.skippedReason
            ? `No calls queued — ${d.skippedReason}.`
            : d.errors?.length
              ? d.errors.join("; ")
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
      const raw = await res.text();
      let d: Record<string, unknown> = {};
      if (raw.trim()) {
        try {
          d = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          setRunMessage({
            type: "error",
            text: res.ok
              ? "Poll returned an invalid response."
              : `Poll failed (${res.status}): server returned non-JSON.`,
          });
          return;
        }
      } else if (!res.ok) {
        setRunMessage({
          type: "error",
          text: `Poll failed (${res.status}): empty response from server.`,
        });
        return;
      }
      if (!res.ok) {
        setRunMessage({
          type: "error",
          text: String(d.error ?? "Run failed"),
        });
        return;
      }
      const totals = d.totals as {
        scanned: number;
        eligible: number;
        enqueued: number;
        cancelled?: number;
        tagsStripped?: number;
      };
      const results = d.results as {
        agentName: string;
        skippedReason: string | null;
        cancelled?: number;
        tagsStripped?: number;
      }[];
      const agentCount = results.length;
      const cancelled = totals.cancelled ?? 0;
      const tagsStripped = totals.tagsStripped ?? 0;
      if (totals.enqueued > 0 || cancelled > 0 || tagsStripped > 0) {
        const parts = [
          totals.enqueued > 0
            ? `Enqueued ${totals.enqueued} call${totals.enqueued === 1 ? "" : "s"} across ${agentCount} agent${agentCount === 1 ? "" : "s"} (${totals.scanned} contacts scanned)`
            : null,
          cancelled > 0 ? `cancelled ${cancelled} stale queue row${cancelled === 1 ? "" : "s"}` : null,
          tagsStripped > 0
            ? `stripped enroll tag from ${tagsStripped} local contact${tagsStripped === 1 ? "" : "s"}`
            : null,
        ].filter(Boolean);
        setRunMessage({
          type: "success",
          text: parts.join("; "),
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

  async function deleteWorkspace() {
    if (deleteConfirmName.trim() !== workspace.name) {
      setDeleteError("Type the workspace name exactly to confirm deletion.");
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmName: deleteConfirmName.trim() }),
      });
      const d = await res.json();
      if (!res.ok) {
        setDeleteError(d.error ?? "Failed to delete workspace");
        return;
      }
      router.push("/");
      router.refresh();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Failed to delete workspace");
    } finally {
      setDeleting(false);
    }
  }

  const today = todayInTz(workspace.timezone);
  const nowEt = nowHHMMInTz(workspace.timezone);
  const tzLabel = timezoneAbbrev(workspace.timezone);
  const selectedCallConfig = selectedOpsAgent
    ? firstEmbed(selectedOpsAgent.agent_call_configs)
    : firstCallConfig(agents);
  const reducedMaxAttempts = agents.reduce(
    (m, a) => Math.max(m, firstEmbed(a.agent_call_configs)?.max_attempts_per_contact ?? 0),
    0
  );
  const maxAttempts =
    selectedCallConfig?.max_attempts_per_contact ??
    (reducedMaxAttempts > 0 ? reducedMaxAttempts : null);
  const windowStart = selectedCallConfig?.call_window_start ?? "09:00";
  const windowEnd = selectedCallConfig?.call_window_end ?? "18:00";
  const dripSeconds = selectedCallConfig?.drip_seconds ?? 60;
  const maxCallsPerDay = selectedCallConfig?.max_calls_per_day ?? 100;
  const agentContacts = selectedOpsAgent
    ? contacts.filter((c) => contactHasEnrollTag(c.tags ?? [], selectedEnrollTag))
    : contacts;
  const schedules = buildSchedules(
    agentContacts,
    today,
    nowEt,
    windowStart,
    windowEnd,
    dripSeconds,
    maxCallsPerDay,
    maxAttempts,
    tzLabel
  );
  const q = query.trim().toLowerCase();
  const filteredContacts = q
    ? agentContacts.filter(
        (c) =>
          (c.full_name ?? "").toLowerCase().includes(q) ||
          c.phones.some((p) => p.toLowerCase().includes(q))
      )
    : agentContacts;
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

  const upcomingCount = agentContacts.filter(
    (c) => !c.is_terminal && !(maxAttempts != null && c.attempt_count >= maxAttempts)
  ).length;
  const activeOutboundCount = agents.filter(
    (a) => a.status === "active" && a.direction === "outbound"
  ).length;
  const canRun = workspace.is_active && activeOutboundCount > 0;

  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">
            Operations
          </h1>
          <p className="mt-1 text-sm text-ink-500">
            Run, monitor, and queue calls for this workspace.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Label className="flex cursor-pointer items-center gap-2 font-normal text-ink-600">
            <input
              type="checkbox"
              checked={runTest}
              onChange={(e) => setRunTest(e.target.checked)}
              className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
            />
            Run test{" "}
            <span className="text-xs text-ink-400">(dials immediately, ignores windows)</span>
          </Label>
          <Button onClick={runPoll} disabled={running || !canRun}>
            {running ? "Running…" : "Run poll"}
          </Button>
          <p className="w-full text-xs text-ink-400 sm:w-auto">
            Polls sync enroll-tagged contacts anytime; dials schedule for the next call window when after hours.
          </p>
          <StatusBadge status={workspace.is_active ? "active" : "paused"} />
        </div>
      </div>

      {runMessage && (
        <div
          className={`mb-5 rounded-xl px-4 py-3 text-sm ${
            runMessage.type === "success"
              ? "bg-accent-mint-bg text-accent-mint-fg"
              : "bg-accent-rose-bg text-accent-rose-fg"
          }`}
        >
          {runMessage.text}
        </div>
      )}

      <SubTabs
        items={[
          { id: "overview", label: "Overview" },
          { id: "queue", label: "Call queue", badge: queueSummary.total || undefined },
          { id: "schedule", label: "Schedule" },
          { id: "outcomes", label: "Outcomes" },
        ]}
        active={opsTab}
        onSelect={(v) => setOpsTab(v)}
      />

      {controlMsg && (
        <div className="mb-5 rounded-xl bg-ink-100 px-4 py-3 text-sm text-ink-600">
          {controlMsg}
        </div>
      )}

      {opsTab === "overview" && (
        <div className="space-y-6">
      {pollRuns.length > 0 && (
        <Card className="p-5">
          <SectionHeader
            title="Recent poll runs"
            description="CRM enroll-tag scan results — scanned, enqueued, and cleanup counts."
          />
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-100 text-left text-xs font-medium uppercase tracking-wide text-ink-400">
                  <th className="px-2 py-2">When</th>
                  <th className="px-2 py-2">Agent</th>
                  <th className="px-2 py-2">Scanned</th>
                  <th className="px-2 py-2">Enqueued</th>
                  <th className="px-2 py-2">Cancelled</th>
                  <th className="px-2 py-2">Tags stripped</th>
                  <th className="px-2 py-2">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {pollRuns.map((run) => {
                  const agentName =
                    agents.find((a) => a.id === run.agent_id)?.name ??
                    run.agent_id.slice(0, 8);
                  return (
                    <tr key={run.id}>
                      <td className="px-2 py-2 text-ink-600">
                        {formatDateTime(run.ran_at, workspace.timezone)}
                      </td>
                      <td className="px-2 py-2 font-medium text-ink-900">{agentName}</td>
                      <td className="px-2 py-2">{run.scanned}</td>
                      <td className="px-2 py-2">{run.enqueued}</td>
                      <td className="px-2 py-2">{run.cancelled}</td>
                      <td className="px-2 py-2">{run.tags_stripped}</td>
                      <td className="px-2 py-2 text-ink-500">
                        {run.trigger_source}
                        {run.skipped_reason ? ` · ${run.skipped_reason}` : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <Card className="p-5">
        <SectionHeader
          title="Workspace controls"
          description="Pause dialing, bulk-enable tasks, and manage the shared CRM connection."
        />
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <Button
            variant={workspace.is_active ? "secondary" : "primary"}
            disabled={savingControl}
            onClick={() => patchWorkspace({ is_active: !workspace.is_active })}
          >
            {workspace.is_active ? "Pause workspace" : "Resume workspace"}
          </Button>
          <Label className="flex cursor-pointer items-center gap-2 font-normal text-ink-600">
            <input
              type="checkbox"
              checked={tasksEnabled}
              disabled={savingControl || agents.length === 0}
              onChange={(e) => patchWorkspace({ tasks_enabled: e.target.checked })}
              className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
            />
            Tasks enabled for all agents
          </Label>
          <Badge tone={workspace.is_active ? "green" : "amber"}>
            {workspace.is_active ? "Active" : "Paused"}
          </Badge>
          {workspace.crm_provider === "highlevel" && (
            <>
              <Badge
                tone={
                  workspace.crm_status === "needs_reauth"
                    ? "red"
                    : workspace.has_workspace_crm_credentials
                      ? "green"
                      : "amber"
                }
              >
                {workspace.crm_status === "needs_reauth"
                  ? "CRM reconnect needed"
                  : workspace.has_workspace_crm_credentials
                    ? "HighLevel connected"
                    : "HighLevel not connected"}
              </Badge>
              <a
                href={`/api/workspaces/${workspaceId}/crm/connect`}
                className="rounded-xl border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50"
              >
                {workspace.has_workspace_crm_credentials
                  ? "Reconnect HighLevel"
                  : "Connect HighLevel (workspace)"}
              </a>
            </>
          )}
        </div>
        {workspace.crm_provider === "highlevel" && workspace.crm_status === "needs_reauth" && (
          <p className="mt-3 rounded-xl bg-accent-rose-bg px-3 py-2 text-xs text-accent-rose-fg">
            The workspace HighLevel token expired. Reconnect once here so all agents
            that inherit workspace CRM can sync again.
          </p>
        )}
      </Card>

      {outboundAgents.length > 1 && (
        <Card className="mb-6 p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <SectionHeader
                title="Operations scope"
                description="Filter schedules, queue actions, and contact lists by outbound agent."
              />
            </div>
            <div className="sm:w-72">
              <Label htmlFor="ops-agent">Outbound agent</Label>
              <Select
                id="ops-agent"
                value={opsAgentId}
                onChange={(e) => setOpsAgent(e.target.value)}
              >
                {outboundAgents.map((a) => {
                  const queued = queueByAgent[a.id] ?? 0;
                  return (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.status}) — {queued} queued
                    </option>
                  );
                })}
              </Select>
            </div>
          </div>
          {selectedOpsAgent && (
            <div className="mt-4 flex flex-wrap gap-3 text-sm text-ink-600">
              <Badge tone={selectedOpsAgent.status === "active" ? "green" : "amber"}>
                {selectedOpsAgent.status}
              </Badge>
              <span>
                Trigger tag:{" "}
                <span className="font-mono text-ink-800">{selectedEnrollTag}</span>
              </span>
              <span className="text-ink-300">·</span>
              <span>
                Window {windowStart}–{windowEnd} {tzLabel}
              </span>
              <span className="text-ink-300">·</span>
              <span>{agentContacts.length} enrolled contacts</span>
              <span className="text-ink-300">·</span>
              <span>{queueSummary.total} in queue</span>
            </div>
          )}
        </Card>
      )}

      <div className="mb-10 grid gap-5 sm:grid-cols-3">
        <StatTile label="Agents" value={agents.length} icon={Bot} tone="sky" />
        <StatTile
          label={selectedOpsAgent ? "Enrolled (agent)" : "Enrolled contacts"}
          value={selectedOpsAgent ? agentContacts.length : contactCount}
          icon={Users}
          tone="mint"
        />
        <StatTile
          label={selectedOpsAgent ? "Trigger tag" : "Default enroll tag"}
          value={
            <span className="font-mono text-base">
              {selectedOpsAgent ? selectedEnrollTag : workspace.enroll_tag}
            </span>
          }
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
                      onChange={(e) => {
                        setOpsAgent(e.target.value);
                      }}
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
          const cc = firstEmbed(a.agent_call_configs);
          const tc = firstEmbed(a.agent_task_configs);
          return (
            <Card
              key={a.id}
              hover
              className="group flex items-center justify-between gap-4 p-5"
            >
              <Link href={`/agents/${a.id}`} className="flex min-w-0 flex-1 items-center gap-4">
                <IconBadge icon={Bot} tone="sky" className="h-10 w-10" />
                <div className="min-w-0">
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
              </Link>
              <div className="flex shrink-0 items-center gap-3 text-right">
                <div className="text-sm text-ink-500">
                  {cc && (
                    <span>
                      {cc.max_calls_per_day}/day · {cc.max_attempts_per_contact} attempts
                    </span>
                  )}
                  <div className="text-xs">{tc?.enabled ? "tasks on" : "no tasks"}</div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  className="gap-1.5"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openDuplicateDialog(a);
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                  Duplicate
                </Button>
                <Link
                  href={`/agents/${a.id}`}
                  className="text-ink-300 transition-colors hover:text-brand-500"
                >
                  <ArrowUpRight className="h-4 w-4" />
                </Link>
              </div>
            </Card>
          );
        })}
      </div>

      <Card className="border-accent-rose-fg/20 p-5">
        <SectionHeader
          title="Delete workspace"
          description="Permanently removes this workspace, all agents, contacts, call history, and queue entries. Retell agents and phone numbers are not deleted automatically."
        />
        <div className="mt-4 max-w-md space-y-3">
          <Label htmlFor="delete-confirm">
            Type <span className="font-medium text-ink-800">{workspace.name}</span> to confirm
          </Label>
          <Input
            id="delete-confirm"
            value={deleteConfirmName}
            onChange={(e) => {
              setDeleteConfirmName(e.target.value);
              setDeleteError(null);
            }}
            placeholder={workspace.name}
            autoComplete="off"
          />
          {deleteError && (
            <div className="rounded-xl bg-accent-rose-bg px-4 py-3 text-sm text-accent-rose-fg">
              {deleteError}
            </div>
          )}
          <Button
            variant="danger"
            disabled={deleting || deleteConfirmName.trim() !== workspace.name}
            onClick={deleteWorkspace}
          >
            {deleting ? "Deleting…" : "Delete workspace permanently"}
          </Button>
        </div>
      </Card>
        </div>
      )}

      {opsTab === "queue" && (
      <div className="mb-10">
        <SectionHeader
          title="Call queue"
          description={
            selectedOpsAgent
              ? `Queue for ${selectedOpsAgent.name}. Contacts appear here when enqueued and are removed after the call finishes.`
              : "Live queue of contacts waiting to dial or currently on a call. Contacts appear here when enqueued and are removed automatically after the call finishes and CRM write-back completes."
          }
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
                  <thead className="sticky top-0 z-10 bg-surface">
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
                            <div className="font-mono text-xs text-ink-400">
                              {entry.phone}
                              {entry.phoneProgress && (
                                <span className="ml-2 font-sans text-ink-500">
                                  ({entry.phoneProgress})
                                </span>
                              )}
                            </div>
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
                            : formatScheduledDisplay(entry.scheduledFor, workspace.timezone)}
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
      )}

      {opsTab === "schedule" && (
      <div className="mb-10">
        <SectionHeader
          title="Call schedule"
          description={
            selectedOpsAgent
              ? `Projected dial times for ${selectedOpsAgent.name} (${selectedEnrollTag}). Window ${windowStart}–${windowEnd} ${tzLabel}.`
              : `Projected next dial times from cadence and drip settings. Use "Call now" to dial a contact immediately for testing, ignoring call windows and cadence.`
          }
          action={
            <div className="flex items-center gap-3">
              {callableAgents.length > 1 && (
                <Select
                  value={activeTestAgentId}
                  onChange={(e) => {
                    setOpsAgent(e.target.value);
                  }}
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
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-200/50 bg-surface px-4 py-3 shadow-card">
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
                <thead className="sticky top-0 z-10 bg-surface">
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
      )}

      {opsTab === "outcomes" && (
      <div className="mb-10">
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
      </div>
      )}

      {duplicateSource && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={closeDuplicateDialog}
        >
          <Card
            className="w-full max-w-md p-6 shadow-lifted"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-ink-900">Duplicate agent</h3>
            <p className="mt-1 text-sm text-ink-500">
              Copy settings from <span className="font-medium">{duplicateSource.name}</span>.
              The new agent starts as draft.
            </p>
            <div className="mt-5 space-y-4">
              <div className="space-y-1.5">
                <Label>Agent name</Label>
                <Input
                  value={duplicateName}
                  onChange={(e) => {
                    setDuplicateName(e.target.value);
                    setDuplicateError(null);
                  }}
                  placeholder="Copy of Seller Outbound"
                />
              </div>
              {duplicateSource.direction === "outbound" && (
                <div className="space-y-1.5">
                  <Label hint="Must be unique in this workspace">
                    Enrollment tag
                  </Label>
                  <Input
                    value={duplicateEnrollTag}
                    onChange={(e) => {
                      setDuplicateEnrollTag(e.target.value);
                      setDuplicateError(null);
                    }}
                    placeholder="upsurge-probate-ai-copy"
                    className="font-mono"
                  />
                  {duplicateEnrollTagValidation(duplicateEnrollTag) && (
                    <p className="text-xs text-accent-rose-fg">
                      {duplicateEnrollTagValidation(duplicateEnrollTag)}
                    </p>
                  )}
                </div>
              )}
              {duplicateError && (
                <div className="rounded-xl bg-accent-rose-bg px-4 py-3 text-sm text-accent-rose-fg">
                  {duplicateError}
                </div>
              )}
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="ghost" onClick={closeDuplicateDialog} disabled={duplicating}>
                Cancel
              </Button>
              <Button
                onClick={submitDuplicate}
                disabled={
                  duplicating ||
                  !duplicateName.trim() ||
                  Boolean(duplicateEnrollTagValidation(duplicateEnrollTag))
                }
              >
                {duplicating ? "Duplicating…" : "Duplicate agent"}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

export { CRM_LABEL };
