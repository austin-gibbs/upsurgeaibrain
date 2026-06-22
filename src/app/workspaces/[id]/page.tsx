"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageShell } from "@/components/TopNav";
import { Card, StatusBadge, Badge } from "@/components/ui";

type Detail = {
  workspace: {
    id: string;
    name: string;
    timezone: string;
    crm_provider: string;
    enroll_tag: string;
    is_active: boolean;
    created_at: string;
  };
  agents: {
    id: string;
    name: string;
    status: string;
    objective: string | null;
    retell_agent_id: string | null;
    retell_from_number: string | null;
    agent_call_configs: { max_calls_per_day: number; max_attempts_per_contact: number }[];
    agent_task_configs: { enabled: boolean }[];
  }[];
  contactCount: number;
  outcomeTags: { outcome: string; tag: string; is_terminal: boolean }[];
};

const CRM_LABEL: Record<string, string> = {
  followupboss: "Follow Up Boss",
  highlevel: "HighLevel",
};

export default function WorkspaceDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/workspaces/${params.id}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(e.message));
  }, [params.id]);

  if (error)
    return (
      <PageShell>
        <Card className="p-4 text-sm text-red-700">{error}</Card>
      </PageShell>
    );
  if (!data)
    return (
      <PageShell>
        <p className="text-sm text-slate-500">Loading…</p>
      </PageShell>
    );

  const { workspace, agents, contactCount, outcomeTags } = data;

  return (
    <PageShell>
      <Link
        href="/"
        className="mb-4 inline-block text-sm text-slate-500 hover:text-slate-700"
      >
        ← Workspaces
      </Link>

      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">
            {workspace.name}
          </h1>
          <p className="text-sm text-slate-500">
            {CRM_LABEL[workspace.crm_provider]} · {workspace.timezone}
          </p>
        </div>
        <StatusBadge status={workspace.is_active ? "active" : "paused"} />
      </div>

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Agents
          </p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">
            {agents.length}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Enrolled contacts
          </p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">
            {contactCount}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Enroll tag
          </p>
          <p className="mt-1 font-mono text-sm text-slate-700">
            {workspace.enroll_tag}
          </p>
        </Card>
      </div>

      <h2 className="mb-3 text-lg font-semibold text-slate-900">Agents</h2>
      <div className="mb-8 grid gap-3">
        {agents.map((a) => {
          const cc = a.agent_call_configs[0];
          const tc = a.agent_task_configs[0];
          return (
            <Link key={a.id} href={`/agents/${a.id}`}>
              <Card className="flex items-center justify-between p-4 transition-shadow hover:shadow-md">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-900">
                      {a.name}
                    </span>
                    <StatusBadge status={a.status} />
                    {!a.retell_agent_id && (
                      <Badge tone="amber">no Retell ID</Badge>
                    )}
                  </div>
                  {a.objective && (
                    <p className="mt-0.5 text-sm text-slate-500">
                      {a.objective}
                    </p>
                  )}
                </div>
                <div className="text-right text-sm text-slate-500">
                  {cc && (
                    <span>
                      {cc.max_calls_per_day}/day · {cc.max_attempts_per_contact}{" "}
                      attempts
                    </span>
                  )}
                  <div className="text-xs">
                    {tc?.enabled ? "tasks on" : "no tasks"}
                  </div>
                </div>
              </Card>
            </Link>
          );
        })}
      </div>

      <h2 className="mb-3 text-lg font-semibold text-slate-900">
        Outcome taxonomy
      </h2>
      <Card className="divide-y divide-slate-100 p-0">
        {outcomeTags.map((t) => (
          <div
            key={t.outcome}
            className="flex items-center justify-between px-4 py-2.5 text-sm"
          >
            <span className="text-slate-700">{t.outcome}</span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-slate-500">{t.tag}</span>
              {t.is_terminal && <Badge tone="red">terminal</Badge>}
            </div>
          </div>
        ))}
      </Card>
    </PageShell>
  );
}
