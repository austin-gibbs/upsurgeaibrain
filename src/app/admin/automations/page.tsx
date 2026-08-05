"use client";

// =====================================================================
// /admin/automations — post-call automation console.
//
// Config-driven post-call triggers: when a Retell call is analyzed, the engine
// matches these triggers against the call's custom_analysis_data (+ outcome/
// summary/transcript) and fires an action (webhook to a HighLevel Inbound
// Webhook, or internal notify). A new automation is a new ROW here — never a
// code deploy.
//
// Everything is scoped to the workspace picked at the top, which is loaded from
// /api/console/workspaces so the exact name never has to be typed. Three tabs:
//   1. Automations — list / create / edit / enable-disable / delete rules.
//   2. Link map    — the per-workspace link_type -> URL map the actions send.
//   3. Run log     — the audit log (queued/sent/failed/dead/skipped).
//
// Drives the session+admin-gated /api/console/automations* routes. Restricted
// to app admins (enforced server-side on every route).
// =====================================================================
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Link2,
  Plus,
  RefreshCw,
  ScrollText,
  Send,
  Trash2,
  Webhook,
  Zap,
} from "lucide-react";
import { PageShell } from "@/components/TopNav";
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  PageGreeting,
  SectionHeader,
  Select,
  Skeleton,
  StatTile,
  SubTabs,
  Switch,
} from "@/components/ui";
import { readJson } from "@/lib/api/fetch-json";
import { TriggerEditor, type EditorAgent, type TestPushResult } from "./TriggerEditor";
import {
  draftFromTrigger,
  summarizeConditions,
  type TriggerPayload,
  type TriggerRow,
} from "@/lib/console/trigger-draft";

const WORKSPACE_STORAGE_KEY = "upsurge-automations-workspace";

type WorkspaceOption = {
  id: string;
  name: string;
  timezone: string;
  crm_provider: string;
  is_active: boolean;
  agents: { id: string; name: string; status: string; direction: string }[];
};

type LinkRow = { link_type: string; url: string; label: string | null };

type RunRow = {
  id: string;
  status: string;
  action_type: string | null;
  contact_phone: string | null;
  request_url: string | null;
  response_status: number | null;
  last_error: string | null;
  attempts: number;
  created_at: string;
  meta: Record<string, unknown> | null;
};

type Feedback = { tone: "success" | "error"; text: string } | null;

const ACTION_ICON: Record<string, typeof Webhook> = {
  webhook: Webhook,
  highlevel_sms: Send,
  internal_notify: Bell,
};

const ACTION_LABEL: Record<string, string> = {
  webhook: "Webhook",
  highlevel_sms: "HighLevel SMS",
  internal_notify: "Internal notify",
};

/** Turn an API error body (message + optional Zod issues) into readable text. */
function apiError(data: unknown, fallback: string): string {
  if (!data || typeof data !== "object") return fallback;
  const body = data as { error?: unknown; issues?: unknown };
  const message = typeof body.error === "string" ? body.error : fallback;
  if (!Array.isArray(body.issues)) return message;
  const issues = body.issues
    .map((raw) => {
      const issue = (raw ?? {}) as { path?: unknown[]; message?: string };
      const path = Array.isArray(issue.path) ? issue.path.join(".") : "";
      return `• ${path || "trigger"}: ${issue.message ?? "invalid"}`;
    })
    .join("\n");
  return issues ? `${message}\n${issues}` : message;
}

function runTone(status: string): "slate" | "green" | "amber" | "red" | "blue" {
  if (status === "sent") return "green";
  if (status === "failed") return "amber";
  if (status === "dead") return "red";
  if (status === "skipped") return "slate";
  return "blue";
}

/* -------------------------------- Link row ------------------------------- */
function LinkRowCard({
  link,
  busy,
  onSave,
  onDelete,
}: {
  link: LinkRow;
  busy: boolean;
  onSave: (next: LinkRow) => void;
  onDelete: () => void;
}) {
  const [url, setUrl] = useState(link.url);
  const [label, setLabel] = useState(link.label ?? "");
  const dirty = url !== link.url || label !== (link.label ?? "");

  return (
    <div className="rounded-xl border border-ink-200/70 bg-surface p-4">
      <div className="mb-3 flex items-center gap-2">
        <code className="rounded-lg bg-ink-100 px-2 py-0.5 font-mono text-xs font-medium text-ink-700">
          {link.link_type}
        </code>
        {dirty && <Badge tone="amber">unsaved</Badge>}
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div>
          <Label htmlFor={`url-${link.link_type}`}>URL</Label>
          <Input
            id={`url-${link.link_type}`}
            className="mt-1.5"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor={`label-${link.link_type}`} hint="optional">
            Label
          </Label>
          <Input
            id={`label-${link.link_type}`}
            className="mt-1.5"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Buyer's Guide PDF"
          />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!dirty || busy}
          onClick={() => onSave({ link_type: link.link_type, url, label: label || null })}
        >
          {busy ? "Saving…" : "Save changes"}
        </Button>
        {dirty && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setUrl(link.url);
              setLabel(link.label ?? "");
            }}
          >
            Reset
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDelete}>
          <Trash2 className="h-4 w-4" strokeWidth={1.75} />
          Delete
        </Button>
      </div>
    </div>
  );
}

/* ---------------------------------- Page --------------------------------- */
export default function AutomationsConsolePage() {
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[] | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [agentFilter, setAgentFilter] = useState("");
  const [tab, setTab] = useState<"triggers" | "links" | "runs">("triggers");
  const [feedback, setFeedback] = useState<Feedback>(null);

  const [triggers, setTriggers] = useState<TriggerRow[] | null>(null);
  const [links, setLinks] = useState<LinkRow[] | null>(null);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [runStatus, setRunStatus] = useState("");
  const [newLink, setNewLink] = useState({ link_type: "", url: "", label: "" });

  const workspace = useMemo(
    () => workspaces?.find((w) => w.name === workspaceName) ?? null,
    [workspaces, workspaceName]
  );
  const agents: EditorAgent[] = useMemo(
    () =>
      (workspace?.agents ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        direction:
          a.direction === "inbound" || a.direction === "outbound"
            ? a.direction
            : undefined,
      })),
    [workspace]
  );

  // Load the workspace list once, then restore the last workspace the admin
  // was working in (falling back to the only one when there's just one).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/console/workspaces")
      .then((res) => readJson<{ workspaces?: WorkspaceOption[]; error?: string }>(res))
      .then((data) => {
        if (cancelled) return;
        if (data.error) {
          setWorkspaces([]);
          setFeedback({ tone: "error", text: data.error });
          return;
        }
        const list = data.workspaces ?? [];
        setWorkspaces(list);
        let remembered = "";
        try {
          remembered = localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "";
        } catch {
          /* private mode — fall through to the default */
        }
        const initial =
          list.find((w) => w.name === remembered)?.name ??
          (list.length === 1 ? list[0].name : "");
        if (initial) setWorkspaceName(initial);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setWorkspaces([]);
        setFeedback({
          tone: "error",
          text: e instanceof Error ? e.message : "Unable to load workspaces.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(
    async (name: string, status: string) => {
      if (!name) return;
      setLoading(true);
      const ws = encodeURIComponent(name);
      const runParams = new URLSearchParams({ workspace: name, limit: "100" });
      if (status) runParams.set("status", status);
      try {
        const [triggerRes, linkRes, runRes] = await Promise.all([
          fetch(`/api/console/automations?workspace=${ws}`),
          fetch(`/api/console/automations/links?workspace=${ws}`),
          fetch(`/api/console/automations/runs?${runParams.toString()}`),
        ]);
        const [triggerData, linkData, runData] = await Promise.all([
          readJson<{ triggers?: TriggerRow[]; error?: string }>(triggerRes),
          readJson<{ links?: LinkRow[]; error?: string }>(linkRes),
          readJson<{ runs?: RunRow[]; error?: string }>(runRes),
        ]);
        setTriggers(triggerRes.ok ? (triggerData.triggers ?? []) : []);
        setLinks(linkRes.ok ? (linkData.links ?? []) : []);
        setRuns(runRes.ok ? (runData.runs ?? []) : []);
        if (!triggerRes.ok) {
          setFeedback({ tone: "error", text: apiError(triggerData, "Failed to load automations.") });
        }
      } catch (e) {
        setFeedback({
          tone: "error",
          text: e instanceof Error ? e.message : "Failed to load this workspace.",
        });
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // Everything reloads as soon as a workspace is chosen — no "Load" button to
  // hunt for, and no panel that silently stays empty.
  useEffect(() => {
    if (!workspaceName) {
      setTriggers(null);
      setLinks(null);
      setRuns(null);
      return;
    }
    try {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, workspaceName);
    } catch {
      /* persistence is a convenience, not a requirement */
    }
    setEditingId(null);
    setCreating(false);
    setAgentFilter("");
    void refresh(workspaceName, runStatus);
    // runStatus has its own reload path below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceName, refresh]);

  const visibleTriggers = useMemo(() => {
    if (!triggers) return null;
    if (!agentFilter) return triggers;
    return triggers.filter((t) => t.agent_id === null || t.agent_id === agentFilter);
  }, [triggers, agentFilter]);

  const runCounts = useMemo(() => {
    const counts = { sent: 0, queued: 0, failed: 0, dead: 0, skipped: 0 };
    for (const r of runs ?? []) {
      if (r.status in counts) counts[r.status as keyof typeof counts] += 1;
    }
    return counts;
  }, [runs]);

  const enabledCount = (triggers ?? []).filter((t) => t.enabled).length;

  /* ------------------------------- mutations ------------------------------ */
  async function createTrigger(payload: TriggerPayload, agentId: string) {
    setBusy("create");
    setFeedback(null);
    try {
      const body: Record<string, unknown> = { ...payload, workspace: workspaceName };
      const agentName = agents.find((a) => a.id === agentId)?.name;
      if (agentName) body.agent = agentName;
      const res = await fetch("/api/console/automations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await readJson<unknown>(res);
      if (!res.ok) {
        setFeedback({ tone: "error", text: apiError(data, "Could not create the automation.") });
        return;
      }
      setCreating(false);
      setFeedback({ tone: "success", text: `Created “${payload.name}”.` });
      await refresh(workspaceName, runStatus);
    } catch (e) {
      setFeedback({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy("");
    }
  }

  async function saveTrigger(id: string, payload: TriggerPayload, agentId: string) {
    setBusy(`save-${id}`);
    setFeedback(null);
    try {
      const res = await fetch(`/api/console/automations/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, agent_id: agentId || null }),
      });
      const data = await readJson<unknown>(res);
      if (!res.ok) {
        setFeedback({ tone: "error", text: apiError(data, "Could not save the automation.") });
        return;
      }
      setEditingId(null);
      setFeedback({ tone: "success", text: `Saved “${payload.name}”.` });
      await refresh(workspaceName, runStatus);
    } catch (e) {
      setFeedback({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy("");
    }
  }

  /**
   * Fire a test push for the automation as currently drafted — saved or not —
   * so the endpoint can be wired up (and field-mapped) before any real call.
   * The run is logged, so it also shows up in the run log.
   */
  async function testPush(
    payload: TriggerPayload,
    agentId: string,
    triggerId?: string
  ): Promise<TestPushResult> {
    setFeedback(null);
    try {
      const body: Record<string, unknown> = { ...payload, workspace: workspaceName };
      const agentName = agents.find((a) => a.id === agentId)?.name;
      if (agentName) body.agent = agentName;
      if (triggerId) body.trigger_id = triggerId;
      const res = await fetch("/api/console/automations/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await readJson<TestPushResult & { error?: string }>(res);
      if (!res.ok) {
        return { delivered: false, error: apiError(data, "The test push could not be sent.") };
      }
      // A logged test is worth refreshing the run log for.
      void refresh(workspaceName, runStatus);
      return data;
    } catch (e) {
      return { delivered: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async function toggleTrigger(trigger: TriggerRow) {
    setBusy(`toggle-${trigger.id}`);
    setFeedback(null);
    try {
      const res = await fetch(`/api/console/automations/${trigger.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !trigger.enabled }),
      });
      const data = await readJson<unknown>(res);
      if (!res.ok) {
        setFeedback({ tone: "error", text: apiError(data, "Could not change the automation.") });
        return;
      }
      setTriggers(
        (prev) =>
          prev?.map((t) => (t.id === trigger.id ? { ...t, enabled: !trigger.enabled } : t)) ?? prev
      );
    } catch (e) {
      setFeedback({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy("");
    }
  }

  async function deleteTrigger(trigger: TriggerRow) {
    if (!confirm(`Delete “${trigger.name}”? Its run history is kept.`)) return;
    setBusy(`del-${trigger.id}`);
    setFeedback(null);
    try {
      const res = await fetch(`/api/console/automations/${trigger.id}`, { method: "DELETE" });
      const data = await readJson<unknown>(res);
      if (!res.ok) {
        setFeedback({ tone: "error", text: apiError(data, "Could not delete the automation.") });
        return;
      }
      setFeedback({ tone: "success", text: `Deleted “${trigger.name}”.` });
      await refresh(workspaceName, runStatus);
    } catch (e) {
      setFeedback({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy("");
    }
  }

  async function upsertLink(link: LinkRow) {
    if (!link.link_type.trim() || !link.url.trim()) {
      setFeedback({ tone: "error", text: "A link needs both a type and a URL." });
      return;
    }
    setBusy(`link-${link.link_type}`);
    setFeedback(null);
    try {
      const res = await fetch("/api/console/automations/links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace: workspaceName,
          link_type: link.link_type.trim(),
          url: link.url.trim(),
          label: link.label?.trim() || null,
        }),
      });
      const data = await readJson<unknown>(res);
      if (!res.ok) {
        setFeedback({ tone: "error", text: apiError(data, "Could not save the link.") });
        return;
      }
      setFeedback({ tone: "success", text: `Saved link “${link.link_type}”.` });
      await refresh(workspaceName, runStatus);
    } catch (e) {
      setFeedback({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy("");
    }
  }

  async function deleteLink(linkType: string) {
    if (!confirm(`Delete the link “${linkType}”?`)) return;
    setBusy(`link-${linkType}`);
    setFeedback(null);
    try {
      const res = await fetch(
        `/api/console/automations/links?workspace=${encodeURIComponent(
          workspaceName
        )}&link_type=${encodeURIComponent(linkType)}`,
        { method: "DELETE" }
      );
      const data = await readJson<unknown>(res);
      if (!res.ok) {
        setFeedback({ tone: "error", text: apiError(data, "Could not delete the link.") });
        return;
      }
      await refresh(workspaceName, runStatus);
    } catch (e) {
      setFeedback({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy("");
    }
  }

  /* --------------------------------- render -------------------------------- */
  const noWorkspace = !workspaceName;

  return (
    <PageShell nav={{ active: "admin", crumb: "Post-call automations" }}>
      <PageGreeting
        title="Post-call automations"
        subtitle="Rules that fire after a call is analyzed. Every automation is configuration — adding or changing one never needs a deploy."
      />

      <div className="space-y-6">
        {feedback && (
          <Banner tone={feedback.tone} onDismiss={() => setFeedback(null)}>
            {feedback.text}
          </Banner>
        )}

        {/* Workspace scope */}
        <Card className="p-6">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
            <div>
              <Label htmlFor="workspace">Workspace</Label>
              <Select
                id="workspace"
                className="mt-1.5"
                value={workspaceName}
                disabled={!workspaces}
                onChange={(e) => setWorkspaceName(e.target.value)}
              >
                <option value="">
                  {workspaces ? "Choose a workspace…" : "Loading workspaces…"}
                </option>
                {workspaces?.map((w) => (
                  <option key={w.id} value={w.name}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="agent-filter" hint="optional">
                Filter by agent
              </Label>
              <Select
                id="agent-filter"
                className="mt-1.5"
                value={agentFilter}
                disabled={!workspace}
                onChange={(e) => setAgentFilter(e.target.value)}
              >
                <option value="">All agents</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              variant="secondary"
              disabled={noWorkspace || loading}
              onClick={() => refresh(workspaceName, runStatus)}
            >
              <RefreshCw
                className={"h-4 w-4" + (loading ? " animate-spin" : "")}
                strokeWidth={1.75}
              />
              Refresh
            </Button>
          </div>
          {workspace && (
            <p className="mt-3 text-xs text-ink-400">
              {workspace.timezone} · {workspace.crm_provider} · {workspace.agents.length} agent
              {workspace.agents.length === 1 ? "" : "s"}
            </p>
          )}
        </Card>

        {noWorkspace ? (
          <EmptyState
            icon={Zap}
            title="Pick a workspace to get started"
            description="Automations, the link map, and the run log are all scoped to one workspace."
          />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                label="Automations"
                value={triggers ? `${enabledCount}/${triggers.length}` : "—"}
                icon={Zap}
                tone="violet"
              />
              <StatTile
                label="Links mapped"
                value={links ? links.length : "—"}
                icon={Link2}
                tone="sky"
              />
              <StatTile
                label="Delivered"
                value={runs ? runCounts.sent : "—"}
                icon={CheckCircle2}
                tone="mint"
              />
              <StatTile
                label="Needs attention"
                value={runs ? runCounts.failed + runCounts.dead : "—"}
                icon={AlertTriangle}
                tone="rose"
              />
            </div>

            <div>
              <SubTabs
                items={[
                  { id: "triggers", label: "Automations", badge: visibleTriggers?.length ?? null },
                  { id: "links", label: "Link map", badge: links?.length ?? null },
                  { id: "runs", label: "Run log", badge: runs?.length ?? null },
                ]}
                active={tab}
                onSelect={(id) => setTab(id)}
              />

              {/* ------------------------- Automations ------------------------- */}
              {tab === "triggers" && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-ink-500">
                      Matched against the call&apos;s <code>custom_analysis_data</code>, plus
                      outcome, summary, and transcript.
                    </p>
                    <Button
                      onClick={() => {
                        setCreating((c) => !c);
                        setEditingId(null);
                      }}
                    >
                      <Plus className="h-4 w-4" strokeWidth={2} />
                      New automation
                    </Button>
                  </div>

                  {creating && (
                    <Card className="p-6">
                      <SectionHeader
                        title="New automation"
                        description="Saved straight to this workspace — no deploy needed."
                      />
                      <TriggerEditor
                        idPrefix="new"
                        agents={agents}
                        submitLabel="Create automation"
                        busy={busy === "create"}
                        onSubmit={createTrigger}
                        onTestPush={(payload, agentId) => testPush(payload, agentId)}
                        onCancel={() => setCreating(false)}
                      />
                    </Card>
                  )}

                  {loading && !triggers && (
                    <div className="space-y-3">
                      <Skeleton className="h-24" />
                      <Skeleton className="h-24" />
                    </div>
                  )}

                  {visibleTriggers?.length === 0 && !creating && (
                    <EmptyState
                      icon={Zap}
                      title="No automations yet"
                      description="Create one to text a link, notify your team, or POST to any endpoint after a call."
                      action={
                        <Button onClick={() => setCreating(true)}>
                          <Plus className="h-4 w-4" strokeWidth={2} />
                          New automation
                        </Button>
                      }
                    />
                  )}

                  {visibleTriggers?.map((t) => {
                    const Icon = ACTION_ICON[t.action_type] ?? Webhook;
                    const isEditing = editingId === t.id;
                    const agentName = t.agent_id
                      ? (agents.find((a) => a.id === t.agent_id)?.name ?? "one agent")
                      : "all agents";
                    const scope =
                      t.direction_scope === "inbound" || t.direction_scope === "outbound"
                        ? t.direction_scope
                        : "all";
                    return (
                      <Card key={t.id} className="overflow-hidden">
                        <div className="flex flex-wrap items-start gap-4 p-5">
                          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-violet-bg text-accent-violet-icon">
                            <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-ink-900">{t.name}</span>
                              <Badge tone={t.enabled ? "green" : "slate"}>
                                {t.enabled ? "enabled" : "disabled"}
                              </Badge>
                              <Badge tone="blue">
                                {ACTION_LABEL[t.action_type] ?? t.action_type}
                              </Badge>
                              <Badge tone="slate">
                                {scope === "all"
                                  ? "all calls"
                                  : scope === "inbound"
                                    ? "inbound"
                                    : "outbound"}
                              </Badge>
                              <span className="text-xs text-ink-400">{agentName}</span>
                            </div>
                            {t.description && (
                              <p className="mt-1 text-sm text-ink-500">{t.description}</p>
                            )}
                            <p className="mt-1.5 text-xs text-ink-400">
                              <span className="font-medium text-ink-500">When</span>{" "}
                              {summarizeConditions(t)}
                              {t.only_outcomes && t.only_outcomes.length > 0 && (
                                <> · outcome in {t.only_outcomes.join(", ")}</>
                              )}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={t.enabled}
                              disabled={busy === `toggle-${t.id}`}
                              onChange={() => toggleTrigger(t)}
                              label={`${t.enabled ? "Disable" : "Enable"} ${t.name}`}
                            />
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => {
                                setEditingId(isEditing ? null : t.id);
                                setCreating(false);
                              }}
                            >
                              {isEditing ? "Close" : "Edit"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy === `del-${t.id}`}
                              onClick={() => deleteTrigger(t)}
                            >
                              <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                            </Button>
                          </div>
                        </div>

                        {isEditing && (
                          <div className="border-t border-ink-100 bg-surface-2/60 p-6">
                            <TriggerEditor
                              key={t.id}
                              idPrefix={t.id}
                              initial={draftFromTrigger(t)}
                              agents={agents}
                              submitLabel="Save changes"
                              busy={busy === `save-${t.id}`}
                              onSubmit={(payload, agentId) => saveTrigger(t.id, payload, agentId)}
                              onTestPush={(payload, agentId) => testPush(payload, agentId, t.id)}
                              onCancel={() => setEditingId(null)}
                            />
                          </div>
                        )}
                      </Card>
                    );
                  })}
                </div>
              )}

              {/* --------------------------- Link map --------------------------- */}
              {tab === "links" && (
                <div className="space-y-4">
                  <p className="text-sm text-ink-500">
                    <code>link_type</code> → URL. The action sends the resolved URL, so the
                    HighLevel workflow stays identical for every client and swapping a link is a
                    data edit.
                  </p>

                  {links?.length === 0 && (
                    <EmptyState
                      icon={Link2}
                      title="No links mapped yet"
                      description="Add the links your agents offer on calls, then reference them by type from an automation."
                    />
                  )}

                  {links?.map((l) => (
                    <LinkRowCard
                      key={`${l.link_type}-${l.url}`}
                      link={l}
                      busy={busy === `link-${l.link_type}`}
                      onSave={upsertLink}
                      onDelete={() => deleteLink(l.link_type)}
                    />
                  ))}

                  <Card className="p-6">
                    <SectionHeader
                      title="Add a link"
                      description="Saving an existing link_type overwrites it."
                    />
                    <div className="grid gap-4 sm:grid-cols-3">
                      <div>
                        <Label htmlFor="new-link-type">Link type</Label>
                        <Input
                          id="new-link-type"
                          className="mt-1.5"
                          value={newLink.link_type}
                          onChange={(e) => setNewLink({ ...newLink, link_type: e.target.value })}
                          placeholder="buyer_guide"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <Label htmlFor="new-link-url">URL</Label>
                        <Input
                          id="new-link-url"
                          className="mt-1.5"
                          value={newLink.url}
                          onChange={(e) => setNewLink({ ...newLink, url: e.target.value })}
                          placeholder="https://…"
                        />
                      </div>
                      <div className="sm:col-span-3">
                        <Label htmlFor="new-link-label" hint="optional">
                          Label
                        </Label>
                        <Input
                          id="new-link-label"
                          className="mt-1.5"
                          value={newLink.label}
                          onChange={(e) => setNewLink({ ...newLink, label: e.target.value })}
                          placeholder="Buyer's Guide PDF"
                        />
                      </div>
                    </div>
                    <div className="mt-4">
                      <Button
                        disabled={
                          !newLink.link_type.trim() ||
                          !newLink.url.trim() ||
                          busy === `link-${newLink.link_type.trim()}`
                        }
                        onClick={async () => {
                          await upsertLink({
                            link_type: newLink.link_type,
                            url: newLink.url,
                            label: newLink.label || null,
                          });
                          setNewLink({ link_type: "", url: "", label: "" });
                        }}
                      >
                        <Plus className="h-4 w-4" strokeWidth={2} />
                        Add link
                      </Button>
                    </div>
                  </Card>
                </div>
              )}

              {/* --------------------------- Run log ---------------------------- */}
              {tab === "runs" && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="w-48">
                      <Label htmlFor="run-status">Status</Label>
                      <Select
                        id="run-status"
                        className="mt-1.5"
                        value={runStatus}
                        onChange={(e) => {
                          setRunStatus(e.target.value);
                          void refresh(workspaceName, e.target.value);
                        }}
                      >
                        <option value="">All statuses</option>
                        <option value="queued">queued</option>
                        <option value="sent">sent</option>
                        <option value="failed">failed</option>
                        <option value="dead">dead</option>
                        <option value="skipped">skipped</option>
                      </Select>
                    </div>
                    <p className="pb-2.5 text-xs text-ink-400">
                      Newest 100 runs. Every match is recorded here before delivery is attempted.
                    </p>
                  </div>

                  {runs?.length === 0 && (
                    <EmptyState
                      icon={ScrollText}
                      title="No runs yet"
                      description="Runs appear here as soon as an analyzed call matches an automation."
                    />
                  )}

                  <div className="space-y-2">
                    {runs?.map((r) => (
                      <div
                        key={r.id}
                        className="rounded-xl border border-ink-200/70 bg-surface px-4 py-3 text-sm"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={runTone(r.status)}>{r.status}</Badge>
                          {r.meta?.test ? <Badge tone="blue">test push</Badge> : null}
                          <span className="text-ink-700">
                            {ACTION_LABEL[r.action_type ?? ""] ?? r.action_type ?? "—"}
                          </span>
                          {r.contact_phone && (
                            <span className="text-ink-400">{r.contact_phone}</span>
                          )}
                          <span className="text-xs text-ink-400">
                            {new Date(r.created_at).toLocaleString()}
                          </span>
                          <span className="text-xs text-ink-400">
                            attempt {r.attempts}
                            {r.response_status ? ` · HTTP ${r.response_status}` : ""}
                          </span>
                        </div>
                        {r.meta?.link_url ? (
                          <p className="mt-1 truncate text-xs text-ink-500">
                            → {String(r.meta.link_url)}
                          </p>
                        ) : null}
                        {r.last_error && (
                          <p className="mt-1 text-xs text-accent-rose-fg">{r.last_error}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </PageShell>
  );
}
