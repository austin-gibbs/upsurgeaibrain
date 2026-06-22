"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageShell } from "@/components/TopNav";
import { Button, Card, Input, Label, StatusBadge, Badge } from "@/components/ui";

type Agent = {
  id: string;
  workspace_id: string;
  name: string;
  status: "draft" | "active" | "paused";
  objective: string | null;
  retell_agent_id: string | null;
  retell_from_number: string | null;
  agent_call_configs: any[];
  agent_task_configs: any[];
};

type CallRow = {
  id: string;
  attempt_number: number;
  to_number: string;
  status: string;
  outcome: string | null;
  in_voicemail: boolean | null;
  summary: string | null;
  applied_tag: string | null;
  task_created: boolean;
  queued_at: string;
  completed_at: string | null;
};

export default function AgentDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  // editable Retell linkage
  const [retellId, setRetellId] = useState("");
  const [fromNumber, setFromNumber] = useState("");

  function load() {
    fetch(`/api/agents/${params.id}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) return setError(d.error);
        setAgent(d.agent);
        setCalls(d.calls);
        setRetellId(d.agent.retell_agent_id ?? "");
        setFromNumber(d.agent.retell_from_number ?? "");
      })
      .catch((e) => setError(e.message));
  }

  useEffect(load, [params.id]);

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    setActionMsg(null);
    try {
      const res = await fetch(`/api/agents/${params.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Failed");
      load();
      setActionMsg("Saved.");
    } catch (e: any) {
      setActionMsg(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (error)
    return (
      <PageShell>
        <Card className="p-4 text-sm text-red-700">{error}</Card>
      </PageShell>
    );
  if (!agent)
    return (
      <PageShell>
        <p className="text-sm text-slate-500">Loading…</p>
      </PageShell>
    );

  const cc = agent.agent_call_configs[0];
  const tc = agent.agent_task_configs[0];

  return (
    <PageShell>
      <Link
        href={`/workspaces/${agent.workspace_id}`}
        className="mb-4 inline-block text-sm text-slate-500 hover:text-slate-700"
      >
        ← Workspace
      </Link>

      <div className="mb-6 flex items-start justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-slate-900">
            {agent.name}
          </h1>
          <StatusBadge status={agent.status} />
        </div>
        <div className="flex items-center gap-2">
          {agent.status !== "active" && (
            <Button
              onClick={() => patch({ status: "active" })}
              disabled={saving}
            >
              Activate
            </Button>
          )}
          {agent.status === "active" && (
            <Button
              variant="secondary"
              onClick={() => patch({ status: "paused" })}
              disabled={saving}
            >
              Pause
            </Button>
          )}
        </div>
      </div>

      {actionMsg && (
        <p className="mb-4 text-sm text-slate-600">{actionMsg}</p>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Retell linkage */}
        <Card className="space-y-4 p-5 lg:col-span-1">
          <h2 className="text-sm font-semibold text-slate-900">
            Retell linkage
          </h2>
          <div className="space-y-1.5">
            <Label>Retell agent ID</Label>
            <Input
              value={retellId}
              onChange={(e) => setRetellId(e.target.value)}
              placeholder="agent_…"
            />
          </div>
          <div className="space-y-1.5">
            <Label>From-number</Label>
            <Input
              value={fromNumber}
              onChange={(e) => setFromNumber(e.target.value)}
              placeholder="+1…"
            />
          </div>
          <Button
            variant="secondary"
            className="w-full"
            disabled={saving}
            onClick={() =>
              patch({
                retell_agent_id: retellId.trim() || null,
                retell_from_number: fromNumber.trim() || null,
              })
            }
          >
            Save linkage
          </Button>
          {(!agent.retell_agent_id || !agent.retell_from_number) && (
            <p className="text-xs text-amber-600">
              Both fields are required before the agent can be activated.
            </p>
          )}
        </Card>

        {/* Config summary */}
        <Card className="space-y-3 p-5 lg:col-span-2">
          <h2 className="text-sm font-semibold text-slate-900">
            Call & task settings
          </h2>
          {cc && (
            <dl className="grid grid-cols-2 gap-y-1.5 text-sm sm:grid-cols-3">
              <Stat label="Calls/day" value={cc.max_calls_per_day} />
              <Stat label="Max attempts" value={cc.max_attempts_per_contact} />
              <Stat
                label="Total cap"
                value={cc.max_total_calls ?? "∞"}
              />
              <Stat
                label="Window"
                value={`${cc.call_window_start}–${cc.call_window_end}`}
              />
              <Stat label="Runs at" value={cc.daily_run_at} />
              <Stat label="Drip" value={`${cc.drip_seconds}s`} />
              <div className="col-span-2 sm:col-span-3">
                <dt className="text-xs uppercase tracking-wide text-slate-400">
                  Cadence (day-gaps)
                </dt>
                <dd className="mt-0.5 font-mono text-xs text-slate-700">
                  {(cc.cadence_day_gaps ?? []).join(", ")}
                </dd>
              </div>
            </dl>
          )}
          <hr className="border-slate-100" />
          {tc?.enabled ? (
            <p className="text-sm text-slate-600">
              Tasks <Badge tone="green">on</Badge> — &ldquo;{tc.name_template}
              &rdquo;
              {tc.assignee_label ? ` → ${tc.assignee_label}` : ""}
            </p>
          ) : (
            <p className="text-sm text-slate-500">
              Tasks <Badge tone="slate">off</Badge>
            </p>
          )}
        </Card>
      </div>

      {/* Call history */}
      <h2 className="mb-3 mt-8 text-lg font-semibold text-slate-900">
        Recent calls
      </h2>
      {calls.length === 0 ? (
        <Card className="p-6 text-center text-sm text-slate-500">
          No calls yet. Calls appear here once the engine starts dialing.
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-4 py-2.5 font-medium">To</th>
                <th className="px-4 py-2.5 font-medium">Attempt</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Outcome</th>
                <th className="px-4 py-2.5 font-medium">Task</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {calls.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 text-slate-500">
                    {new Date(c.queued_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-700">
                    {c.to_number}
                  </td>
                  <td className="px-4 py-2.5 text-slate-700">
                    #{c.attempt_number}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="px-4 py-2.5 text-slate-700">
                    {c.outcome ?? "—"}
                    {c.in_voicemail && (
                      <span className="ml-1 text-xs text-slate-400">(vm)</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {c.task_created ? (
                      <Badge tone="green">created</Badge>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </PageShell>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-400">
        {label}
      </dt>
      <dd className="text-slate-800">{value}</dd>
    </div>
  );
}
