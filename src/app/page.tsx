"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Building2, Bot, Tag, ArrowUpRight } from "lucide-react";
import { PageShell } from "@/components/TopNav";
import {
  Button,
  Card,
  StatusBadge,
  PageGreeting,
  IconBadge,
  EmptyState,
  Skeleton,
} from "@/components/ui";

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
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <PageGreeting
          title="Workspaces"
          subtitle="Each workspace is one client, one CRM, and its AI voice agents."
        />
        <Link href="/setup">
          <Button size="lg">+ New workspace</Button>
        </Link>
      </div>

      {error && (
        <Card className="mb-6 p-5 text-sm text-accent-rose-fg">
          Failed to load: {error}
        </Card>
      )}

      {!workspaces && !error && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="p-6">
              <Skeleton className="mb-4 h-5 w-2/3" />
              <Skeleton className="mb-2 h-4 w-full" />
              <Skeleton className="mb-2 h-4 w-4/5" />
              <Skeleton className="h-4 w-3/5" />
            </Card>
          ))}
        </div>
      )}

      {workspaces && workspaces.length === 0 && (
        <EmptyState
          icon={Building2}
          title="No workspaces yet"
          description="Create your first workspace to connect a CRM and deploy AI voice agents."
          action={
            <Link href="/setup">
              <Button>Create your first workspace</Button>
            </Link>
          }
        />
      )}

      {workspaces && workspaces.length > 0 && (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces.map((ws) => {
            const activeAgents = ws.agents.filter(
              (a) => a.status === "active"
            ).length;
            return (
              <Link key={ws.id} href={`/workspaces/${ws.id}`}>
                <Card hover className="group h-full p-6">
                  <div className="mb-5 flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <IconBadge icon={Building2} tone="sky" />
                      <div>
                        <h2 className="font-semibold text-ink-900">
                          {ws.name}
                        </h2>
                        <p className="text-xs text-ink-400">
                          {CRM_LABEL[ws.crm_provider]}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge
                        status={ws.is_active ? "active" : "paused"}
                      />
                      <ArrowUpRight className="h-4 w-4 text-ink-300 transition-colors group-hover:text-brand-500" />
                    </div>
                  </div>
                  <dl className="space-y-2.5 text-sm">
                    <div className="flex items-center justify-between">
                      <dt className="flex items-center gap-2 text-ink-500">
                        <Bot className="h-3.5 w-3.5" />
                        Agents
                      </dt>
                      <dd className="font-medium text-ink-700">
                        {ws.agents.length}
                        {activeAgents > 0 && (
                          <span className="ml-1 text-accent-mint-fg">
                            ({activeAgents} active)
                          </span>
                        )}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between">
                      <dt className="flex items-center gap-2 text-ink-500">
                        <Tag className="h-3.5 w-3.5" />
                        Enroll tag
                      </dt>
                      <dd className="font-mono text-xs text-ink-600">
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
