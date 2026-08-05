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
// Four panels, all keyed by workspace NAME (agent optional):
//   1. Triggers   — list / create / enable-disable / delete rules.
//   2. Links      — the per-workspace link map (link_type -> URL) the actions send.
//   3. Runs       — the audit log (queued/sent/failed/dead/skipped).
//
// Drives the session+admin-gated /api/console/automations* routes. Restricted
// to app admins (enforced server-side on every route).
// =====================================================================
import { useState } from "react";
import { PageShell } from "@/components/TopNav";
import { Badge, Button, Card, Input, Label, SectionHeader } from "@/components/ui";
import { readJson } from "@/lib/api/fetch-json";

// A ready-to-edit trigger. This is Paul Avratin's "send the link they asked
// for" automation: when the call captured link_requested=true, POST to the
// client's HighLevel Inbound Webhook with the resolved link so HighLevel texts
// it. link_type_field reads which link from the call; the Links panel maps each
// link_type to a URL, so HighLevel stays "dumb" and identical per client.
const TRIGGER_TEMPLATE = `{
  "name": "Send requested link",
  "description": "Caller asked for a link — text it via HighLevel.",
  "enabled": true,
  "match_type": "all",
  "conditions": [
    { "field": "link_requested", "operator": "is_true" }
  ],
  "action_type": "highlevel_sms",
  "action_config": {
    "url": "https://services.leadconnectorhq.com/hooks/PASTE_HIGHLEVEL_INBOUND_WEBHOOK",
    "link_type_field": "link_type",
    "message_template": "Hi {{contact.first_name}}, here's the info you asked for: {{link.url}}"
  },
  "dedupe_window_hours": 24,
  "max_attempts": 5,
  "only_outcomes": null
}`;

const textareaClass =
  "w-full rounded-xl border border-ink-200/80 bg-surface px-4 py-3 font-mono text-xs text-ink-900 shadow-soft placeholder:text-ink-400 transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20";

type Trigger = {
  id: string;
  agent_id: string | null;
  name: string;
  description: string | null;
  enabled: boolean;
  match_type: string;
  action_type: string;
  conditions: unknown;
  action_config: Record<string, unknown>;
  dedupe_window_hours: number;
  max_attempts: number;
  only_outcomes: string[] | null;
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

function ResultBox({ data }: { data: unknown }) {
  if (data === null || data === undefined) return null;
  return (
    <pre className="mt-4 max-h-80 overflow-auto rounded-xl bg-ink-900/95 p-4 text-xs leading-relaxed text-ink-50">
      {typeof data === "string" ? data : JSON.stringify(data, null, 2)}
    </pre>
  );
}

export default function AutomationsConsolePage() {
  const [workspace, setWorkspace] = useState("");
  const [agent, setAgent] = useState("");

  // Triggers
  const [triggers, setTriggers] = useState<Trigger[] | null>(null);
  const [triggerJson, setTriggerJson] = useState(TRIGGER_TEMPLATE);
  const [trigBusy, setTrigBusy] = useState("");
  const [trigResult, setTrigResult] = useState<unknown>(null);

  // Links
  const [links, setLinks] = useState<LinkRow[] | null>(null);
  const [linkType, setLinkType] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [linkBusy, setLinkBusy] = useState("");
  const [linkResult, setLinkResult] = useState<unknown>(null);

  // Runs
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [runStatus, setRunStatus] = useState("");
  const [runBusy, setRunBusy] = useState("");

  const wsQuery = () => {
    const p = new URLSearchParams({ workspace: workspace.trim() });
    if (agent.trim()) p.set("agent", agent.trim());
    return p.toString();
  };

  async function loadTriggers() {
    if (!workspace.trim()) return;
    setTrigBusy("load");
    setTrigResult(null);
    try {
      const res = await fetch(`/api/console/automations?${wsQuery()}`);
      const data = await readJson<any>(res);
      if (res.ok) setTriggers(data.triggers ?? []);
      else setTrigResult(data);
    } catch (e) {
      setTrigResult(e instanceof Error ? e.message : String(e));
    } finally {
      setTrigBusy("");
    }
  }

  async function createTrigger() {
    if (!workspace.trim()) return;
    setTrigBusy("create");
    setTrigResult(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(triggerJson);
    } catch (e) {
      setTrigResult(`Trigger is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      setTrigBusy("");
      return;
    }
    try {
      const body: Record<string, unknown> = { ...parsed, workspace: workspace.trim() };
      if (agent.trim()) body.agent = agent.trim();
      const res = await fetch("/api/console/automations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await readJson<any>(res);
      setTrigResult(data);
      if (res.ok) loadTriggers();
    } catch (e) {
      setTrigResult(e instanceof Error ? e.message : String(e));
    } finally {
      setTrigBusy("");
    }
  }

  async function toggleTrigger(t: Trigger) {
    setTrigBusy(`toggle-${t.id}`);
    try {
      const res = await fetch(`/api/console/automations/${t.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !t.enabled }),
      });
      const data = await readJson<any>(res);
      if (res.ok) loadTriggers();
      else setTrigResult(data);
    } catch (e) {
      setTrigResult(e instanceof Error ? e.message : String(e));
    } finally {
      setTrigBusy("");
    }
  }

  async function deleteTrigger(t: Trigger) {
    if (!confirm(`Delete trigger "${t.name}"? Its run history is kept.`)) return;
    setTrigBusy(`del-${t.id}`);
    try {
      const res = await fetch(`/api/console/automations/${t.id}`, { method: "DELETE" });
      const data = await readJson<any>(res);
      if (res.ok) loadTriggers();
      else setTrigResult(data);
    } catch (e) {
      setTrigResult(e instanceof Error ? e.message : String(e));
    } finally {
      setTrigBusy("");
    }
  }

  async function loadLinks() {
    if (!workspace.trim()) return;
    setLinkBusy("load");
    setLinkResult(null);
    try {
      const res = await fetch(
        `/api/console/automations/links?workspace=${encodeURIComponent(workspace.trim())}`
      );
      const data = await readJson<any>(res);
      if (res.ok) setLinks(data.links ?? []);
      else setLinkResult(data);
    } catch (e) {
      setLinkResult(e instanceof Error ? e.message : String(e));
    } finally {
      setLinkBusy("");
    }
  }

  async function upsertLink() {
    if (!workspace.trim() || !linkType.trim() || !linkUrl.trim()) return;
    setLinkBusy("save");
    setLinkResult(null);
    try {
      const res = await fetch("/api/console/automations/links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace: workspace.trim(),
          link_type: linkType.trim(),
          url: linkUrl.trim(),
          label: linkLabel.trim() || null,
        }),
      });
      const data = await readJson<any>(res);
      setLinkResult(data);
      if (res.ok) {
        setLinkType("");
        setLinkUrl("");
        setLinkLabel("");
        loadLinks();
      }
    } catch (e) {
      setLinkResult(e instanceof Error ? e.message : String(e));
    } finally {
      setLinkBusy("");
    }
  }

  async function deleteLink(lt: string) {
    if (!confirm(`Delete link "${lt}"?`)) return;
    setLinkBusy(`del-${lt}`);
    try {
      const res = await fetch(
        `/api/console/automations/links?workspace=${encodeURIComponent(
          workspace.trim()
        )}&link_type=${encodeURIComponent(lt)}`,
        { method: "DELETE" }
      );
      const data = await readJson<any>(res);
      if (res.ok) loadLinks();
      else setLinkResult(data);
    } catch (e) {
      setLinkResult(e instanceof Error ? e.message : String(e));
    } finally {
      setLinkBusy("");
    }
  }

  async function loadRuns() {
    if (!workspace.trim()) return;
    setRunBusy("load");
    try {
      const p = new URLSearchParams({ workspace: workspace.trim(), limit: "100" });
      if (runStatus) p.set("status", runStatus);
      const res = await fetch(`/api/console/automations/runs?${p.toString()}`);
      const data = await readJson<any>(res);
      if (res.ok) setRuns(data.runs ?? []);
    } catch {
      /* surfaced via empty state */
    } finally {
      setRunBusy("");
    }
  }

  const runTone = (s: string): "slate" | "green" | "amber" | "red" | "blue" =>
    s === "sent"
      ? "green"
      : s === "failed"
        ? "amber"
        : s === "dead"
          ? "red"
          : s === "skipped"
            ? "slate"
            : "blue";

  return (
    <PageShell nav={{ active: "admin", crumb: "Post-call automations" }}>
      <div className="mx-auto w-full max-w-5xl space-y-8 py-8">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">Post-Call Automations</h1>
          <p className="mt-1 text-sm text-ink-500">
            Config-driven triggers that fire after a call is analyzed. New automations are data,
            not deploys.
          </p>
        </div>

        {/* Scope */}
        <Card className="p-6">
          <SectionHeader title="Workspace" description="All panels below are scoped to this workspace." />
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="ws">Workspace name</Label>
              <Input
                id="ws"
                value={workspace}
                onChange={(e) => setWorkspace(e.target.value)}
                placeholder="United Real Estate Experts"
              />
            </div>
            <div>
              <Label htmlFor="ag">Agent name (optional)</Label>
              <Input
                id="ag"
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                placeholder="Leave blank = all agents"
              />
            </div>
          </div>
        </Card>

        {/* Triggers */}
        <Card className="p-6">
          <SectionHeader
            title="Triggers"
            description="Rules matched against the call's custom_analysis_data (+ outcome/summary/transcript)."
          />
          <div className="mb-4 flex flex-wrap gap-2">
            <Button onClick={loadTriggers} disabled={!workspace.trim() || trigBusy === "load"}>
              {trigBusy === "load" ? "Loading…" : "Load triggers"}
            </Button>
          </div>

          {triggers && triggers.length === 0 && (
            <p className="mb-4 text-sm text-ink-500">No triggers yet for this workspace.</p>
          )}
          {triggers && triggers.length > 0 && (
            <div className="mb-6 space-y-2">
              {triggers.map((t) => (
                <div
                  key={t.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ink-200/70 bg-surface px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-ink-900">{t.name}</span>
                      <Badge tone={t.enabled ? "green" : "slate"}>
                        {t.enabled ? "enabled" : "disabled"}
                      </Badge>
                      <span className="text-xs text-ink-400">
                        {t.action_type} · {t.agent_id ? "agent-scoped" : "all agents"}
                      </span>
                    </div>
                    {t.description && (
                      <p className="mt-0.5 truncate text-xs text-ink-500">{t.description}</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => toggleTrigger(t)}
                      disabled={trigBusy === `toggle-${t.id}`}
                    >
                      {t.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => deleteTrigger(t)}
                      disabled={trigBusy === `del-${t.id}`}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <Label htmlFor="trig">New trigger (JSON)</Label>
          <textarea
            id="trig"
            className={textareaClass}
            rows={18}
            value={triggerJson}
            onChange={(e) => setTriggerJson(e.target.value)}
          />
          <div className="mt-3">
            <Button onClick={createTrigger} disabled={!workspace.trim() || trigBusy === "create"}>
              {trigBusy === "create" ? "Creating…" : "Create trigger"}
            </Button>
          </div>
          <ResultBox data={trigResult} />
        </Card>

        {/* Links */}
        <Card className="p-6">
          <SectionHeader
            title="Link map"
            description="link_type → URL. The action sends the URL; HighLevel stays identical per client."
          />
          <div className="mb-4 flex flex-wrap gap-2">
            <Button onClick={loadLinks} disabled={!workspace.trim() || linkBusy === "load"}>
              {linkBusy === "load" ? "Loading…" : "Load links"}
            </Button>
          </div>

          {links && links.length > 0 && (
            <div className="mb-6 space-y-2">
              {links.map((l) => (
                <div
                  key={l.link_type}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ink-200/70 bg-surface px-4 py-3"
                >
                  <div className="min-w-0">
                    <span className="font-medium text-ink-900">{l.link_type}</span>
                    {l.label && <span className="ml-2 text-xs text-ink-400">{l.label}</span>}
                    <p className="mt-0.5 truncate text-xs text-ink-500">{l.url}</p>
                  </div>
                  <Button
                    variant="danger"
                    onClick={() => deleteLink(l.link_type)}
                    disabled={linkBusy === `del-${l.link_type}`}
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          )}
          {links && links.length === 0 && (
            <p className="mb-4 text-sm text-ink-500">No links yet for this workspace.</p>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <Label htmlFor="lt">link_type</Label>
              <Input
                id="lt"
                value={linkType}
                onChange={(e) => setLinkType(e.target.value)}
                placeholder="buyer_guide"
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="lu">URL</Label>
              <Input
                id="lu"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                placeholder="https://…"
              />
            </div>
            <div className="sm:col-span-3">
              <Label htmlFor="ll">Label (optional)</Label>
              <Input
                id="ll"
                value={linkLabel}
                onChange={(e) => setLinkLabel(e.target.value)}
                placeholder="Buyer's Guide PDF"
              />
            </div>
          </div>
          <div className="mt-3">
            <Button
              onClick={upsertLink}
              disabled={!workspace.trim() || !linkType.trim() || !linkUrl.trim() || linkBusy === "save"}
            >
              {linkBusy === "save" ? "Saving…" : "Save link"}
            </Button>
          </div>
          <ResultBox data={linkResult} />
        </Card>

        {/* Runs */}
        <Card className="p-6">
          <SectionHeader title="Run log" description="Every match becomes a run — the audit trail." />
          <div className="mb-4 flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor="rs">Status filter</Label>
              <select
                id="rs"
                className="rounded-xl border border-ink-200/80 bg-surface px-3 py-2 text-sm text-ink-900 shadow-soft focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                value={runStatus}
                onChange={(e) => setRunStatus(e.target.value)}
              >
                <option value="">All</option>
                <option value="queued">queued</option>
                <option value="sent">sent</option>
                <option value="failed">failed</option>
                <option value="dead">dead</option>
                <option value="skipped">skipped</option>
              </select>
            </div>
            <Button onClick={loadRuns} disabled={!workspace.trim() || runBusy === "load"}>
              {runBusy === "load" ? "Loading…" : "Load runs"}
            </Button>
          </div>

          {runs && runs.length === 0 && (
            <p className="text-sm text-ink-500">No runs match.</p>
          )}
          {runs && runs.length > 0 && (
            <div className="space-y-2">
              {runs.map((r) => (
                <div
                  key={r.id}
                  className="rounded-xl border border-ink-200/70 bg-surface px-4 py-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={runTone(r.status)}>{r.status}</Badge>
                    <span className="text-ink-700">{r.action_type ?? "—"}</span>
                    {r.contact_phone && <span className="text-ink-400">{r.contact_phone}</span>}
                    <span className="text-xs text-ink-400">
                      {new Date(r.created_at).toLocaleString()}
                    </span>
                    <span className="text-xs text-ink-400">
                      attempt {r.attempts}
                      {r.response_status ? ` · HTTP ${r.response_status}` : ""}
                    </span>
                  </div>
                  {r.meta?.link_url ? (
                    <p className="mt-1 truncate text-xs text-ink-500">→ {String(r.meta.link_url)}</p>
                  ) : null}
                  {r.last_error && (
                    <p className="mt-1 text-xs text-accent-rose-fg">{r.last_error}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </PageShell>
  );
}
