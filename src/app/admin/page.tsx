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
      "max_calls_per_day": 100,
      "max_attempts_per_contact": 10,
      "call_window_start": "09:00",
      "call_window_end": "19:00",
      "daily_run_at": "09:00",
      "drip_seconds": 60,
      "cadence_day_gaps": [0, 1, 2, 3, 5, 7, 10, 14, 21, 30]
    }
  }
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

  // Team members
  const [tmName, setTmName] = useState("");
  const [tmEmail, setTmEmail] = useState("");
  const [tmPassword, setTmPassword] = useState("");
  const [tmBusy, setTmBusy] = useState("");
  const [tmResult, setTmResult] = useState<unknown>(null);
  const [admins, setAdmins] = useState<
    Array<{ id: string; email: string; full_name: string | null }> | null
  >(null);

  // Delete workspace
  const [deleteConfirmName, setDeleteConfirmName] = useState("");

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
    <PageShell nav={{ active: "dashboard", crumb: "Admin console" }}>
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
