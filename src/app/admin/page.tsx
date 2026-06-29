"use client";

// =====================================================================
// /admin — in-app provisioning console.
//
// Drives the session+admin-gated /api/console/* routes so a Retell agent can
// be provisioned, activated, and tuned without the terminal. Restricted to
// emails in ADMIN_EMAILS (enforced server-side on every route).
//
// Two panels:
//   1. Provision — paste/edit a spec JSON, dry-run to validate, then provision.
//   2. Manage existing — by workspace name: status, activate, set call window.
// =====================================================================
import { useState } from "react";
import { PageShell } from "@/components/TopNav";
import { Button, Card, Input, Label, SectionHeader } from "@/components/ui";

const SPEC_TEMPLATE = `{
  "direction": "outbound",
  "activate": true,
  "ownerEmail": "you@example.com",
  "retell": {
    "apiKey": "PASTE_CLIENT_RETELL_API_KEY",
    "voiceId": "11labs-Adrian",
    "model": "gpt-4o",
    "language": "en-US",
    "responseEngine": { "type": "retell-llm" },
    "generalPrompt": "You are a friendly appointment-setter for <BUSINESS>. Goal: <OBJECTIVE>. Keep it natural and concise.",
    "beginMessage": "Hi, this is <NAME> calling from <BUSINESS> — do you have a quick minute?",
    "phone": { "mode": "provision", "areaCode": 470 }
  },
  "workspace": {
    "mode": "new",
    "organizationName": "Acme Holdings",
    "name": "Acme Realty",
    "timezone": "America/New_York",
    "crmProvider": "followupboss",
    "enrollTag": "upsurgecallflowai"
  },
  "agent": {
    "name": "Acme Outbound Setter",
    "enrollTag": "acme-outbound",
    "objective": "Book a listing appointment",
    "callConfig": {
      "max_total_calls": null,
      "max_calls_per_day": 100,
      "max_attempts_per_contact": 10,
      "call_window_start": "09:00",
      "call_window_end": "19:00",
      "daily_run_at": "09:00",
      "drip_seconds": 60,
      "cadence_day_gaps": [0, 1, 2, 3, 5, 7, 10, 14, 21, 30]
    },
    "taskConfig": {
      "enabled": false,
      "pipeline_automation_enabled": false,
      "poll_stage_enabled": false,
      "poll_pipeline_id": null,
      "poll_pipeline_stage_id": null,
      "opportunity_custom_field_enabled": false,
      "opportunity_custom_field_id": null,
      "opportunity_custom_field_value": null
    },
    "pipelineStageMap": []
  }
}`;

// Template for the "Edit agent config" panel. Send only the sections you want
// to change. taskConfig MERGES; pipelineStageMap REPLACES (pass [] to clear).
// IDs for poll_pipeline_*, opportunity_custom_field_*, and the stage map come
// from "Fetch HighLevel pipelines & fields". HighLevel features are no-ops on
// Follow Up Boss. Outcomes: appointment, not_interested, dnd,
// interested_no_appointment, follow_up, error, no_answer.
const CONFIG_TEMPLATE = `{
  "taskConfig": {
    "pipeline_automation_enabled": true,
    "poll_stage_enabled": true,
    "poll_pipeline_id": "PIPELINE_ID",
    "poll_pipeline_stage_id": "STAGE_ID",
    "opportunity_custom_field_enabled": false,
    "opportunity_custom_field_id": null,
    "opportunity_custom_field_value": null
  },
  "pipelineStageMap": [
    { "outcome": "appointment", "call_attempt": null, "pipeline_id": "PIPELINE_ID", "pipeline_stage_id": "BOOKED_STAGE_ID" },
    { "outcome": "not_interested", "call_attempt": null, "pipeline_id": "PIPELINE_ID", "pipeline_stage_id": "LOST_STAGE_ID" }
  ]
}`;

const textareaClass =
  "w-full rounded-xl border border-ink-200/80 bg-surface px-4 py-3 font-mono text-xs text-ink-900 shadow-soft placeholder:text-ink-400 transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20";

function ResultBox({ data }: { data: unknown }) {
  if (data === null || data === undefined) return null;
  return (
    <pre className="mt-4 max-h-96 overflow-auto rounded-xl bg-ink-900/95 p-4 text-xs leading-relaxed text-ink-50">
      {typeof data === "string" ? data : JSON.stringify(data, null, 2)}
    </pre>
  );
}

export default function AdminConsolePage() {
  // Provision panel
  const [spec, setSpec] = useState(SPEC_TEMPLATE);
  const [provBusy, setProvBusy] = useState<"" | "dry" | "real">("");
  const [provResult, setProvResult] = useState<unknown>(null);

  // Manage panel
  const [workspace, setWorkspace] = useState("");
  const [mgmtBusy, setMgmtBusy] = useState("");
  const [mgmtResult, setMgmtResult] = useState<unknown>(null);

  // Call window
  const [start, setStart] = useState("23:00");
  const [end, setEnd] = useState("23:59");
  const [runAt, setRunAt] = useState("23:00");
  const [gap, setGap] = useState("1");
  const [attempts, setAttempts] = useState("30");

  // Agent automations / config (HighLevel routing, task config, call config)
  const [agentName, setAgentName] = useState("");
  const [cfgBusy, setCfgBusy] = useState("");
  const [cfgText, setCfgText] = useState(CONFIG_TEMPLATE);
  const [cfgResult, setCfgResult] = useState<unknown>(null);
  const [hlResult, setHlResult] = useState<unknown>(null);

  // Team members
  const [tmName, setTmName] = useState("");
  const [tmEmail, setTmEmail] = useState("");
  const [diagBusy, setDiagBusy] = useState("");
  const [diagResult, setDiagResult] = useState<unknown>(null);
  const [reconcileBusy, setReconcileBusy] = useState("");
  const [reconcileResult, setReconcileResult] = useState<unknown>(null);
  const [tmPassword, setTmPassword] = useState("");
  const [tmBusy, setTmBusy] = useState("");
  const [tmResult, setTmResult] = useState<unknown>(null);
  const [admins, setAdmins] = useState<
    Array<{ id: string; email: string; full_name: string | null }> | null
  >(null);

  // Delete workspace
  const [deleteConfirmName, setDeleteConfirmName] = useState("");

  async function loadDiagnostics() {
    setDiagBusy("load");
    setDiagResult(null);
    try {
      const res = await fetch("/api/console/diagnostics");
      const data = await res.json();
      setDiagResult(data);
    } catch (e) {
      setDiagResult(e instanceof Error ? e.message : String(e));
    } finally {
      setDiagBusy("");
    }
  }

  async function runReconcile(dryRun: boolean) {
    setReconcileBusy(dryRun ? "dry" : "run");
    setReconcileResult(null);
    try {
      const res = await fetch("/api/console/reconcile-stuck-calls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun, limit: 200, olderThanMinutes: 5 }),
      });
      const data = await res.json();
      setReconcileResult(data);
      if (res.ok && !dryRun) await loadDiagnostics();
    } catch (e) {
      setReconcileResult(e instanceof Error ? e.message : String(e));
    } finally {
      setReconcileBusy("");
    }
  }

  async function loadAdmins() {
    setTmBusy("list");
    try {
      const res = await fetch("/api/console/team-members");
      const data = await res.json();
      if (res.ok) setAdmins(data.admins ?? []);
      else setTmResult(data);
    } catch (e) {
      setTmResult(e instanceof Error ? e.message : String(e));
    } finally {
      setTmBusy("");
    }
  }

  async function addTeamMember() {
    if (!tmEmail.trim() || tmPassword.length < 8) return;
    setTmBusy("add");
    setTmResult(null);
    try {
      const res = await fetch("/api/console/team-members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fullName: tmName.trim(),
          email: tmEmail.trim(),
          password: tmPassword,
        }),
      });
      const data = await res.json();
      setTmResult(data);
      if (res.ok) {
        setTmName("");
        setTmEmail("");
        setTmPassword("");
        loadAdmins();
      }
    } catch (e) {
      setTmResult(e instanceof Error ? e.message : String(e));
    } finally {
      setTmBusy("");
    }
  }

  async function provision(dryRun: boolean) {
    setProvBusy(dryRun ? "dry" : "real");
    setProvResult(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(spec);
    } catch (e) {
      setProvResult(
        `Spec is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
      );
      setProvBusy("");
      return;
    }
    try {
      const res = await fetch("/api/console/provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spec: parsed, dryRun }),
      });
      setProvResult(await res.json());
    } catch (e) {
      setProvResult(e instanceof Error ? e.message : String(e));
    } finally {
      setProvBusy("");
    }
  }

  async function callStatus() {
    if (!workspace.trim()) return;
    setMgmtBusy("status");
    setMgmtResult(null);
    try {
      const res = await fetch(
        `/api/console/status?workspace=${encodeURIComponent(workspace.trim())}`
      );
      setMgmtResult(await res.json());
    } catch (e) {
      setMgmtResult(e instanceof Error ? e.message : String(e));
    } finally {
      setMgmtBusy("");
    }
  }

  async function activate(dryRun: boolean) {
    if (!workspace.trim()) return;
    setMgmtBusy(dryRun ? "activate-dry" : "activate");
    setMgmtResult(null);
    try {
      const res = await fetch("/api/console/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: workspace.trim(), dryRun }),
      });
      setMgmtResult(await res.json());
    } catch (e) {
      setMgmtResult(e instanceof Error ? e.message : String(e));
    } finally {
      setMgmtBusy("");
    }
  }

  async function setCallWindow() {
    if (!workspace.trim()) return;
    setMgmtBusy("call-window");
    setMgmtResult(null);
    try {
      const res = await fetch("/api/console/call-window", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace: workspace.trim(),
          start,
          end,
          runAt,
          gap: Number(gap),
          attempts: Number(attempts),
        }),
      });
      setMgmtResult(await res.json());
    } catch (e) {
      setMgmtResult(e instanceof Error ? e.message : String(e));
    } finally {
      setMgmtBusy("");
    }
  }

  async function fetchHighLevel() {
    if (!workspace.trim()) return;
    setCfgBusy("hl");
    setHlResult(null);
    try {
      const params = new URLSearchParams({ workspace: workspace.trim() });
      if (agentName.trim()) params.set("agent", agentName.trim());
      const res = await fetch(`/api/console/highlevel?${params.toString()}`);
      setHlResult(await res.json());
    } catch (e) {
      setHlResult(e instanceof Error ? e.message : String(e));
    } finally {
      setCfgBusy("");
    }
  }

  async function loadAgentConfig() {
    if (!workspace.trim()) return;
    setCfgBusy("load");
    setCfgResult(null);
    try {
      const params = new URLSearchParams({ workspace: workspace.trim() });
      if (agentName.trim()) params.set("agent", agentName.trim());
      const res = await fetch(`/api/console/agent-config?${params.toString()}`);
      const data = await res.json();
      if (res.ok) {
        setCfgText(
          JSON.stringify(
            {
              callConfig: data.callConfig,
              taskConfig: data.taskConfig,
              pipelineStageMap: data.pipelineStageMap,
            },
            null,
            2
          )
        );
        setCfgResult({
          ok: true,
          loaded: data.agent,
          effectiveCrmProvider: data.effectiveCrmProvider,
        });
      } else {
        setCfgResult(data);
      }
    } catch (e) {
      setCfgResult(e instanceof Error ? e.message : String(e));
    } finally {
      setCfgBusy("");
    }
  }

  async function saveAgentConfig() {
    if (!workspace.trim()) return;
    setCfgBusy("save");
    setCfgResult(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(cfgText);
    } catch (e) {
      setCfgResult(
        `Config is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
      );
      setCfgBusy("");
      return;
    }
    try {
      const res = await fetch("/api/console/agent-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace: workspace.trim(),
          agent: agentName.trim() || undefined,
          ...parsed,
        }),
      });
      setCfgResult(await res.json());
    } catch (e) {
      setCfgResult(e instanceof Error ? e.message : String(e));
    } finally {
      setCfgBusy("");
    }
  }

  async function deleteWorkspace(dryRun: boolean) {
    if (!workspace.trim()) return;
    setMgmtBusy(dryRun ? "delete-dry" : "delete");
    setMgmtResult(null);
    try {
      const res = await fetch("/api/console/delete-workspace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace: workspace.trim(),
          confirmName: deleteConfirmName.trim(),
          dryRun,
        }),
      });
      const data = await res.json();
      setMgmtResult(data);
      if (res.ok && !dryRun && data.deleted) {
        setWorkspace("");
        setDeleteConfirmName("");
      }
    } catch (e) {
      setMgmtResult(e instanceof Error ? e.message : String(e));
    } finally {
      setMgmtBusy("");
    }
  }

  return (
    <PageShell nav={{ active: "admin", crumb: "Admin console" }}>
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">
            Provisioning console
          </h1>
          <p className="mt-1 text-sm text-ink-600">
            Author a Retell agent, wire it into UpSurge, and activate it — no
            terminal. Connect the CRM in the app; then activate here.
          </p>
        </div>

        {/* ----------------------- Provision ----------------------- */}
        <Card className="p-6">
          <SectionHeader title="Provision a new agent" />
          <p className="mb-3 text-sm text-ink-600">
            Paste the spec (the client&apos;s Retell API key goes in{" "}
            <code>retell.apiKey</code>). Dry-run validates the spec without
            touching Retell or the database.
          </p>
          <textarea
            className={textareaClass}
            rows={22}
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            spellCheck={false}
          />
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              variant="secondary"
              onClick={() => provision(true)}
              disabled={provBusy !== ""}
            >
              {provBusy === "dry" ? "Validating…" : "Dry-run (validate)"}
            </Button>
            <Button
              onClick={() => provision(false)}
              disabled={provBusy !== ""}
            >
              {provBusy === "real" ? "Provisioning…" : "Provision"}
            </Button>
          </div>
          <ResultBox data={provResult} />
        </Card>

        {/* --------------------- Manage existing -------------------- */}
        <Card className="p-6">
          <SectionHeader title="Manage an existing workspace" />
          <div className="max-w-md">
            <Label htmlFor="ws">Workspace name</Label>
            <Input
              id="ws"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              placeholder="UpSurge Test"
            />
          </div>

          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              variant="secondary"
              onClick={callStatus}
              disabled={mgmtBusy !== "" || !workspace.trim()}
            >
              {mgmtBusy === "status" ? "Loading…" : "Status"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => activate(true)}
              disabled={mgmtBusy !== "" || !workspace.trim()}
            >
              {mgmtBusy === "activate-dry" ? "Checking…" : "Activate (dry-run)"}
            </Button>
            <Button
              onClick={() => activate(false)}
              disabled={mgmtBusy !== "" || !workspace.trim()}
            >
              {mgmtBusy === "activate" ? "Activating…" : "Activate"}
            </Button>
          </div>

          <div className="mt-6">
            <SectionHeader title="Call window / cadence" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <div>
                <Label htmlFor="start">Start</Label>
                <Input id="start" value={start} onChange={(e) => setStart(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="end">End</Label>
                <Input id="end" value={end} onChange={(e) => setEnd(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="runAt">Run at</Label>
                <Input id="runAt" value={runAt} onChange={(e) => setRunAt(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="gap">Day gap</Label>
                <Input id="gap" value={gap} onChange={(e) => setGap(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="attempts">Attempts</Label>
                <Input id="attempts" value={attempts} onChange={(e) => setAttempts(e.target.value)} />
              </div>
            </div>
            <div className="mt-4">
              <Button
                variant="secondary"
                onClick={setCallWindow}
                disabled={mgmtBusy !== "" || !workspace.trim()}
              >
                {mgmtBusy === "call-window" ? "Saving…" : "Set call window"}
              </Button>
            </div>
          </div>

          <div className="mt-8 border-t border-ink-200/60 pt-6">
            <SectionHeader
              title="Agent automations & config (call settings + HighLevel routing)"
              description="Edit an existing agent's call settings, task/automation config, and outcome→stage routing. Optional agent name disambiguates a workspace with more than one agent. HighLevel features no-op on Follow Up Boss."
            />
            <div className="max-w-md">
              <Label htmlFor="agentName">Agent name (optional)</Label>
              <Input
                id="agentName"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder="leave blank if the workspace has one agent"
              />
            </div>

            <div className="mt-4 flex flex-wrap gap-3">
              <Button
                variant="secondary"
                onClick={fetchHighLevel}
                disabled={cfgBusy !== "" || !workspace.trim()}
              >
                {cfgBusy === "hl"
                  ? "Fetching…"
                  : "Fetch HighLevel pipelines & fields"}
              </Button>
              <Button
                variant="secondary"
                onClick={loadAgentConfig}
                disabled={cfgBusy !== "" || !workspace.trim()}
              >
                {cfgBusy === "load" ? "Loading…" : "Load current config"}
              </Button>
            </div>

            <ResultBox data={hlResult} />

            <p className="mb-2 mt-5 text-sm text-ink-600">
              Send only the sections you want to change.{" "}
              <code>callConfig</code> and <code>taskConfig</code> merge over the
              existing row; <code>pipelineStageMap</code> replaces all rules
              (send <code>[]</code> to clear).
            </p>
            <textarea
              className={textareaClass}
              rows={18}
              value={cfgText}
              onChange={(e) => setCfgText(e.target.value)}
              spellCheck={false}
            />
            <div className="mt-4">
              <Button
                onClick={saveAgentConfig}
                disabled={cfgBusy !== "" || !workspace.trim()}
              >
                {cfgBusy === "save" ? "Saving…" : "Save config"}
              </Button>
            </div>
            <ResultBox data={cfgResult} />
          </div>

          <div className="mt-8 border-t border-ink-200/60 pt-6">
            <SectionHeader
              title="Delete workspace"
              description="Permanently removes the workspace and all related data. Retell resources are not deleted automatically."
            />
            <div className="max-w-md">
              <Label htmlFor="deleteConfirm">
                Type the workspace name to confirm
              </Label>
              <Input
                id="deleteConfirm"
                value={deleteConfirmName}
                onChange={(e) => setDeleteConfirmName(e.target.value)}
                placeholder={workspace.trim() || "Workspace name"}
                autoComplete="off"
              />
            </div>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button
                variant="secondary"
                onClick={() => deleteWorkspace(true)}
                disabled={mgmtBusy !== "" || !workspace.trim()}
              >
                {mgmtBusy === "delete-dry" ? "Previewing…" : "Delete (dry-run)"}
              </Button>
              <Button
                variant="danger"
                onClick={() => deleteWorkspace(false)}
                disabled={
                  mgmtBusy !== "" ||
                  !workspace.trim() ||
                  deleteConfirmName.trim() !== workspace.trim()
                }
              >
                {mgmtBusy === "delete" ? "Deleting…" : "Delete permanently"}
              </Button>
            </div>
          </div>

          <ResultBox data={mgmtResult} />
        </Card>

        {/* ---------------------- Diagnostics ---------------------- */}
        <Card className="p-6">
          <SectionHeader
            title="Platform diagnostics"
            description="Webhook health, Redis/engine queue connectivity, stuck dialing calls, and reporting backfill status."
          />
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              variant="secondary"
              onClick={loadDiagnostics}
              disabled={diagBusy !== ""}
            >
              {diagBusy === "load" ? "Loading…" : "Refresh diagnostics"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => runReconcile(true)}
              disabled={reconcileBusy !== ""}
            >
              {reconcileBusy === "dry" ? "Previewing…" : "Reconcile (dry-run)"}
            </Button>
            <Button
              onClick={() => runReconcile(false)}
              disabled={reconcileBusy !== ""}
            >
              {reconcileBusy === "run" ? "Reconciling…" : "Reconcile stuck calls"}
            </Button>
          </div>
          <ResultBox data={diagResult} />
          <ResultBox data={reconcileResult} />
        </Card>

        {/* ---------------------- Team members ---------------------- */}
        <Card className="p-6">
          <SectionHeader
            title="Team members (admin access)"
            description="New admins can sign in and have full access to every workspace."
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="tmName">Full name</Label>
              <Input
                id="tmName"
                value={tmName}
                onChange={(e) => setTmName(e.target.value)}
                placeholder="Jane Doe"
              />
            </div>
            <div>
              <Label htmlFor="tmEmail">Email</Label>
              <Input
                id="tmEmail"
                type="email"
                value={tmEmail}
                onChange={(e) => setTmEmail(e.target.value)}
                placeholder="jane@upsurgecrmpros.com"
              />
            </div>
            <div>
              <Label htmlFor="tmPassword">Password</Label>
              <Input
                id="tmPassword"
                type="password"
                value={tmPassword}
                onChange={(e) => setTmPassword(e.target.value)}
                placeholder="min 8 characters"
              />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              onClick={addTeamMember}
              disabled={
                tmBusy !== "" || !tmEmail.trim() || tmPassword.length < 8
              }
            >
              {tmBusy === "add" ? "Adding…" : "Add admin"}
            </Button>
            <Button
              variant="secondary"
              onClick={loadAdmins}
              disabled={tmBusy !== ""}
            >
              {tmBusy === "list" ? "Loading…" : "List current admins"}
            </Button>
          </div>

          {admins && (
            <div className="mt-4 overflow-hidden rounded-xl border border-ink-200/70">
              <table className="w-full text-left text-sm">
                <thead className="bg-ink-50 text-ink-600">
                  <tr>
                    <th className="px-4 py-2 font-medium">Name</th>
                    <th className="px-4 py-2 font-medium">Email</th>
                  </tr>
                </thead>
                <tbody>
                  {admins.length === 0 ? (
                    <tr>
                      <td className="px-4 py-2 text-ink-500" colSpan={2}>
                        No admins found.
                      </td>
                    </tr>
                  ) : (
                    admins.map((a) => (
                      <tr key={a.id} className="border-t border-ink-200/60">
                        <td className="px-4 py-2 text-ink-800">
                          {a.full_name ?? "—"}
                        </td>
                        <td className="px-4 py-2 text-ink-800">{a.email}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          <ResultBox data={tmResult} />
        </Card>
      </div>
    </PageShell>
  );
}
