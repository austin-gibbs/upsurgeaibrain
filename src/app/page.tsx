"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageShell } from "@/components/TopNav";
import { Button, Card, StatusBadge } from "@/components/ui";

type WorkspaceRow = {
  id: string;
  name: string;
  timezone: string;
  crm_provider: "followupboss" | "highlevel";
  enroll_tag: string;
  is_active: boolean;
  created_at: string;
  agents: { id: string; name: string; status: string }[];
};

const CRM_LABEL: Record<string, string> = {
  followupboss: "Follow Up Boss",
  highlevel: "HighLevel",
};

export default function DashboardPage() {
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/workspaces")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setWorkspaces(d.workspaces);
      })
      .catch((e) => setError(e.message));
  }, []);

  return (
    <PageShell>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Workspaces</h1>
          <p className="text-sm text-slate-500">
            Each workspace is one client, one CRM, and its AI voice agents.
          </p>
        </div>
        <Link href="/setup">
          <Button>+ New workspace</Button>
        </Link>
      </div>

      {error && (
        <Card className="p-4 text-sm text-red-700">Failed to load: {error}</Card>
      )}

      {!workspaces && !error && (
        <p className="text-sm text-slate-500">Loading…</p>
      )}

      {workspaces && workspaces.length === 0 && (
        <Card className="flex flex-col items-center justify-center gap-3 p-12 text-center">
          <p className="text-slate-600">No workspaces yet.</p>
          <Link href="/setup">
            <Button>Create your first workspace</Button>
          </Link>
        </Card>
      )}

      {workspaces && workspaces.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces.map((ws) => {
            const activeAgents = ws.agents.filter(
              (a) => a.status === "active"
            ).length;
            return (
              <Link key={ws.id} href={`/workspaces/${ws.id}`}>
                <Card className="h-full p-5 transition-shadow hover:shadow-md">
                  <div className="mb-3 flex items-start justify-between">
                    <h2 className="font-semibold text-slate-900">{ws.name}</h2>
                    <StatusBadge status={ws.is_active ? "active" : "paused"} />
                  </div>
                  <dl className="space-y-1 text-sm text-slate-500">
                    <div className="flex justify-between">
                      <dt>CRM</dt>
                      <dd className="text-slate-700">
                        {CRM_LABEL[ws.crm_provider]}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Agents</dt>
                      <dd className="text-slate-700">
                        {ws.agents.length}{" "}
                        {activeAgents > 0 && (
                          <span className="text-green-600">
                            ({activeAgents} active)
                          </span>
                        )}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Enroll tag</dt>
                      <dd className="font-mono text-xs text-slate-700">
                        {ws.enroll_tag}
                      </dd>
                    </div>
                  </dl>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
