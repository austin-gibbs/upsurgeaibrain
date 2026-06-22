"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Bot,
  Users,
  Tags,
  ArrowUpRight,
  CalendarClock,
  Search,
} from "lucide-react";
import { PageShell } from "@/components/TopNav";
import {
  Card,
  StatusBadge,
  Badge,
  StatTile,
  SectionHeader,
  IconBadge,
  Input,
  EmptyState,
} from "@/components/ui";

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
    agent_call_configs: {
      max_calls_per_day: number;
      max_attempts_per_contact: number;
    }[];
    agent_task_configs: { enabled: boolean }[];
  }[];
  contactCount: number;
  contacts: ContactRow[];
  outcomeTags: { outcome: string; tag: string; is_terminal: boolean }[];
};

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

const CRM_LABEL: Record<string, string> = {
  followupboss: "Follow Up Boss",
  highlevel: "HighLevel",
};

type BadgeTone = "slate" | "green" | "amber" | "red" | "blue";

/** Today's date (YYYY-MM-DD) in the workspace timezone. */
function todayInTz(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Friendly label for a YYYY-MM-DD calendar date (e.g. "Mon, Jun 23"). */
function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${iso}T12:00:00Z`));
}

/** Whole days from one YYYY-MM-DD to another. */
function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

type Schedule = { label: string; tone: BadgeTone; note?: string };

/**
 * Describe when a contact's next call will happen, mirroring the engine's
 * eligibility rules (terminal → done, attempt cap → done, next_eligible_on in
 * the future → that date, otherwise eligible at the next 9am ET poll).
 */
function describeNextCall(
  c: ContactRow,
  today: string,
  maxAttempts: number | null
): Schedule {
  if (c.is_terminal) {
    return {
      label: "Completed",
      tone: "slate",
      note: c.terminal_outcome ? c.terminal_outcome.replace(/_/g, " ") : undefined,
    };
  }
  if (maxAttempts != null && c.attempt_count >= maxAttempts) {
    return { label: "Finished", tone: "slate", note: "max attempts reached" };
  }
  const next = c.next_eligible_on;
  if (!next || next <= today) {
    return { label: "Eligible now", tone: "green", note: "dials at next 9am ET run" };
  }
  const d = daysBetween(today, next);
  const note = d === 1 ? "tomorrow" : `in ${d} days`;
  return { label: formatDate(next), tone: "blue", note };
}

export default function WorkspaceDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetch(`/api/workspaces/${params.id}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(e.message));
  }, [params.id]);

  if (error)
    return (
      <PageShell>
        <Card className="p-5 text-sm text-accent-rose-fg">{error}</Card>
      </PageShell>
    );
  if (!data)
    return (
      <PageShell>
        <p className="text-sm text-ink-500">Loading…</p>
      </PageShell>
    );

  const { workspace, agents, contactCount, contacts, outcomeTags } = data;

  const today = todayInTz(workspace.timezone);
  const maxAttempts =
    agents.reduce(
      (m, a) => Math.max(m, a.agent_call_configs[0]?.max_attempts_per_contact ?? 0),
      0
    ) || null;
  const q = query.trim().toLowerCase();
  const filteredContacts = q
    ? contacts.filter(
        (c) =>
          (c.full_name ?? "").toLowerCase().includes(q) ||
          c.phones.some((p) => p.toLowerCase().includes(q))
      )
    : contacts;
  const upcomingCount = contacts.filter(
    (c) => !c.is_terminal && !(maxAttempts != null && c.attempt_count >= maxAttempts)
  ).length;

  return (
    <PageShell>
      <Link
        href="/"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-ink-500 transition-colors hover:text-ink-700"
      >
        <ArrowLeft className="h-4 w-4" />
        Workspaces
      </Link>

      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-900 sm:text-3xl">
            {workspace.name}
          </h1>
          <p className="mt-1.5 text-sm text-ink-500">
            {CRM_LABEL[workspace.crm_provider]} · {workspace.timezone}
          </p>
        </div>
        <StatusBadge status={workspace.is_active ? "active" : "paused"} />
      </div>

      <div className="mb-10 grid gap-5 sm:grid-cols-3">
        <StatTile label="Agents" value={agents.length} icon={Bot} tone="sky" />
        <StatTile
          label="Enrolled contacts"
          value={contactCount}
          icon={Users}
          tone="mint"
        />
        <StatTile
          label="Enroll tag"
          value={
            <span className="font-mono text-base">{workspace.enroll_tag}</span>
          }
          icon={Tags}
          tone="violet"
        />
      </div>

      <SectionHeader title="Agents" />
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
                      <span className="font-semibold text-ink-900">
                        {a.name}
                      </span>
                      <StatusBadge status={a.status} />
                      {!a.retell_agent_id && (
                        <Badge tone="amber">no Retell ID</Badge>
                      )}
                    </div>
                    {a.objective && (
                      <p className="mt-0.5 text-sm text-ink-500">
                        {a.objective}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-4 text-right">
                  <div className="text-sm text-ink-500">
                    {cc && (
                      <span>
                        {cc.max_calls_per_day}/day ·{" "}
                        {cc.max_attempts_per_contact} attempts
                      </span>
                    )}
                    <div className="text-xs">
                      {tc?.enabled ? "tasks on" : "no tasks"}
                    </div>
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
          title="Call schedule"
          description="When each enrolled contact is next set to dial. Calls only place between 9am–7pm ET, starting at the daily 9am run and spaced out from there."
          action={
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name or number"
                className="w-64 pl-9"
              />
            </div>
          }
        />
        {contacts.length > 0 && (
          <p className="-mt-2 mb-4 text-sm text-ink-500">
            <span className="font-medium text-ink-700">{upcomingCount}</span> upcoming
            {" · "}
            <span className="font-medium text-ink-700">
              {contacts.length - upcomingCount}
            </span>{" "}
            finished
            {contactCount > contacts.length && ` · showing ${contacts.length} of ${contactCount}`}
          </p>
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
                    : `Contacts tagged "${workspace.enroll_tag}" will appear here once the agent runs its first poll.`
                }
              />
            </div>
          ) : (
            <div className="max-h-[34rem] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-white">
                  <tr className="border-b border-ink-100 text-left text-xs font-medium uppercase tracking-wide text-ink-400">
                    <th className="px-5 py-3 font-medium">Contact</th>
                    <th className="px-5 py-3 font-medium">Attempts</th>
                    <th className="px-5 py-3 font-medium">Last call</th>
                    <th className="px-5 py-3 font-medium">Next call</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {filteredContacts.map((c) => {
                    const s = describeNextCall(c, today, maxAttempts);
                    return (
                      <tr
                        key={c.id}
                        className="transition-colors hover:bg-ink-50/50"
                      >
                        <td className="px-5 py-3.5">
                          <div className="font-medium text-ink-900">
                            {c.full_name ?? "Unknown contact"}
                          </div>
                          {c.phones[0] && (
                            <div className="font-mono text-xs text-ink-400">
                              {c.phones[0]}
                            </div>
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
                          <div className="flex flex-col items-start gap-0.5">
                            <Badge tone={s.tone}>{s.label}</Badge>
                            {s.note && (
                              <span className="text-xs text-ink-400">{s.note}</span>
                            )}
                          </div>
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
    </PageShell>
  );
}
