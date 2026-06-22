"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Phone, Settings, Clock, KeyRound } from "lucide-react";
import { PageShell } from "@/components/TopNav";
import {
  Button,
  Card,
  Input,
  Label,
  StatusBadge,
  Badge,
  SectionHeader,
  IconBadge,
  Segmented,
  Select,
} from "@/components/ui";

type Direction = "inbound" | "outbound";
type CrmProvider = "followupboss" | "highlevel";

type Agent = {
  id: string;
  workspace_id: string;
  name: string;
  status: "draft" | "active" | "paused";
  direction: Direction;
  objective: string | null;
  enroll_tag: string | null;
  retell_agent_id: string | null;
  retell_from_number: string | null;
  crm_provider: CrmProvider | null;
  has_crm_credentials: boolean;
  has_retell_credentials: boolean;
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

  const [direction, setDirection] = useState<Direction>("outbound");
  const [retellId, setRetellId] = useState("");
  const [fromNumber, setFromNumber] = useState("");
  const [enrollTag, setEnrollTag] = useState("");

  const [crmProvider, setCrmProvider] = useState<CrmProvider>("followupboss");
  const [fubApiKey, setFubApiKey] = useState("");
  const [hlAccessToken, setHlAccessToken] = useState("");
  const [hlLocationId, setHlLocationId] = useState("");

  const [retellApiKey, setRetellApiKey] = useState("");
  const [retellWebhookSecret, setRetellWebhookSecret] = useState("");

  function load() {
    fetch(`/api/agents/${params.id}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) return setError(d.error);
        setAgent(d.agent);
        setCalls(d.calls);
        setDirection(d.agent.direction ?? "outbound");
        setRetellId(d.agent.retell_agent_id ?? "");
        setFromNumber(d.agent.retell_from_number ?? "");
        setEnrollTag(d.agent.enroll_tag ?? "");
        setCrmProvider(d.agent.crm_provider ?? "followupboss");
        setFubApiKey("");
        setHlAccessToken("");
        setHlLocationId("");
        setRetellApiKey("");
        setRetellWebhookSecret("");
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

  function saveLinkage() {
    patch({
      retell_agent_id: retellId.trim() || null,
      retell_from_number: direction === "outbound" ? fromNumber.trim() || null : null,
    });
  }

  function saveDirection() {
    patch({
      direction,
      enroll_tag: direction === "outbound" ? enrollTag.trim() || null : null,
    });
  }

  function saveCrm() {
    const body: Record<string, unknown> = { crm_provider: crmProvider };
    if (crmProvider === "followupboss" && fubApiKey.trim()) {
      body.crm_credentials = { apiKey: fubApiKey.trim() };
    } else if (
      crmProvider === "highlevel" &&
      (hlAccessToken.trim() || hlLocationId.trim())
    ) {
      if (!hlAccessToken.trim() || !hlLocationId.trim()) {
        setActionMsg("HighLevel needs both access token and location ID.");
        return;
      }
      body.crm_credentials = {
        accessToken: hlAccessToken.trim(),
        locationId: hlLocationId.trim(),
      };
    }
    patch(body);
  }

  function saveRetellCreds() {
    if (!retellApiKey.trim()) {
      setActionMsg("Enter a Retell API key to update credentials.");
      return;
    }
    patch({
      retell_credentials: {
        apiKey: retellApiKey.trim(),
        ...(retellWebhookSecret.trim()
          ? { webhookSecret: retellWebhookSecret.trim() }
          : {}),
      },
    });
  }

  if (error)
    return (
      <PageShell>
        <Card className="p-5 text-sm text-accent-rose-fg">{error}</Card>
      </PageShell>
    );
  if (!agent)
    return (
      <PageShell>
        <p className="text-sm text-ink-500">Loading…</p>
      </PageShell>
    );

  const isInbound = direction === "inbound";
  const cc = agent.agent_call_configs[0];
  const tc = agent.agent_task_configs[0];

  const linkageReady = isInbound
    ? Boolean(agent.retell_agent_id && agent.has_retell_credentials)
    : Boolean(agent.retell_agent_id && agent.retell_from_number);

  return (
    <PageShell>
      <Link
        href={`/workspaces/${agent.workspace_id}`}
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-ink-500 transition-colors hover:text-ink-700"
      >
        <ArrowLeft className="h-4 w-4" />
        Workspace
      </Link>

      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <IconBadge icon={Phone} tone="sky" className="h-12 w-12 rounded-2xl" />
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight text-ink-900 sm:text-3xl">
                {agent.name}
              </h1>
              <StatusBadge status={agent.status} />
              <Badge tone={isInbound ? "blue" : "green"}>
                {isInbound ? "Inbound" : "Outbound"}
              </Badge>
            </div>
            {agent.objective && (
              <p className="mt-1 text-sm text-ink-500">{agent.objective}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {agent.status !== "active" && (
            <Button onClick={() => patch({ status: "active" })} disabled={saving}>
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
        <p className="mb-6 rounded-xl bg-ink-100 px-4 py-2.5 text-sm text-ink-600">
          {actionMsg}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="space-y-5 p-6 lg:col-span-1">
          <div className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-ink-400" />
            <h2 className="text-sm font-semibold text-ink-900">Agent type</h2>
          </div>
          <Segmented<Direction>
            value={direction}
            onChange={setDirection}
            options={[
              { value: "outbound", label: "Outbound" },
              { value: "inbound", label: "Inbound" },
            ]}
          />
          {!isInbound && (
            <div className="space-y-1.5">
              <Label hint="CRM tag that enrolls contacts">Enrollment tag</Label>
              <Input
                value={enrollTag}
                onChange={(e) => setEnrollTag(e.target.value)}
                placeholder="upsurge-probate-ai"
              />
            </div>
          )}
          <Button
            variant="secondary"
            className="w-full"
            disabled={saving}
            onClick={saveDirection}
          >
            Save type
          </Button>
        </Card>

        <Card className="space-y-5 p-6 lg:col-span-1">
          <div className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-ink-400" />
            <h2 className="text-sm font-semibold text-ink-900">Retell linkage</h2>
          </div>
          <div className="space-y-1.5">
            <Label>Retell agent ID</Label>
            <Input
              value={retellId}
              onChange={(e) => setRetellId(e.target.value)}
              placeholder="agent_…"
            />
          </div>
          {!isInbound && (
            <div className="space-y-1.5">
              <Label>From-number</Label>
              <Input
                value={fromNumber}
                onChange={(e) => setFromNumber(e.target.value)}
                placeholder="+1…"
              />
            </div>
          )}
          <Button
            variant="secondary"
            className="w-full"
            disabled={saving}
            onClick={saveLinkage}
          >
            Save linkage
          </Button>
          {!linkageReady && (
            <p className="text-xs text-accent-amber-fg">
              {isInbound
                ? "Retell agent ID and credentials are required before activation."
                : "Retell agent ID and from-number are required before activation."}
            </p>
          )}
        </Card>

        <Card className="space-y-5 p-6 lg:col-span-1">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-ink-400" />
            <h2 className="text-sm font-semibold text-ink-900">CRM</h2>
          </div>
          <div className="space-y-1.5">
            <Label>Provider</Label>
            <Select
              value={crmProvider}
              onChange={(e) => setCrmProvider(e.target.value as CrmProvider)}
            >
              <option value="followupboss">Follow Up Boss</option>
              <option value="highlevel">HighLevel</option>
            </Select>
          </div>
          {agent.has_crm_credentials && (
            <p className="text-xs text-accent-mint-fg">Credentials stored (encrypted)</p>
          )}
          {crmProvider === "followupboss" ? (
            <div className="space-y-1.5">
              <Label hint="leave blank to keep current">API key</Label>
              <Input
                type="password"
                value={fubApiKey}
                onChange={(e) => setFubApiKey(e.target.value)}
                placeholder="fka_…"
              />
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label hint="leave blank to keep current">Access token</Label>
                <Input
                  type="password"
                  value={hlAccessToken}
                  onChange={(e) => setHlAccessToken(e.target.value)}
                  placeholder="eyJ…"
                />
              </div>
              <div className="space-y-1.5">
                <Label hint="leave blank to keep current">Location ID</Label>
                <Input
                  value={hlLocationId}
                  onChange={(e) => setHlLocationId(e.target.value)}
                  placeholder="loc_…"
                />
              </div>
            </>
          )}
          <Button
            variant="secondary"
            className="w-full"
            disabled={saving}
            onClick={saveCrm}
          >
            Save CRM
          </Button>
        </Card>
      </div>

      {isInbound && (
        <Card className="mt-6 space-y-5 p-6">
          <SectionHeader
            title="Retell credentials"
            description="Stored encrypted. Leave fields blank to keep current values."
          />
          {agent.has_retell_credentials && (
            <p className="text-xs text-accent-mint-fg">Credentials stored (encrypted)</p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Retell API key</Label>
              <Input
                type="password"
                value={retellApiKey}
                onChange={(e) => setRetellApiKey(e.target.value)}
                placeholder="key_…"
              />
            </div>
            <div className="space-y-1.5">
              <Label hint="optional">Webhook secret</Label>
              <Input
                type="password"
                value={retellWebhookSecret}
                onChange={(e) => setRetellWebhookSecret(e.target.value)}
                placeholder="whsec_…"
              />
            </div>
          </div>
          <Button variant="secondary" disabled={saving} onClick={saveRetellCreds}>
            Save Retell credentials
          </Button>
        </Card>
      )}

      {!isInbound && (
        <Card className="mt-6 space-y-4 p-6">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-ink-400" />
            <h2 className="text-sm font-semibold text-ink-900">
              Call & task settings
            </h2>
          </div>
          {cc && (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm sm:grid-cols-3">
              <Stat label="Calls/day" value={cc.max_calls_per_day} />
              <Stat label="Max attempts" value={cc.max_attempts_per_contact} />
              <Stat label="Total cap" value={cc.max_total_calls ?? "∞"} />
              <Stat
                label="Window"
                value={`${cc.call_window_start}–${cc.call_window_end}`}
              />
              <Stat label="Runs at" value={cc.daily_run_at} />
              <Stat label="Drip" value={`${cc.drip_seconds}s`} />
              <div className="col-span-2 sm:col-span-3">
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">
                  Cadence (day-gaps)
                </dt>
                <dd className="mt-1 font-mono text-xs text-ink-600">
                  {(cc.cadence_day_gaps ?? []).join(", ")}
                </dd>
              </div>
            </dl>
          )}
          <hr className="border-ink-100" />
          {tc?.enabled ? (
            <p className="text-sm text-ink-600">
              Tasks <Badge tone="green">on</Badge> — &ldquo;{tc.name_template}
              &rdquo;
              {tc.assignee_label ? ` → ${tc.assignee_label}` : ""}
            </p>
          ) : (
            <p className="text-sm text-ink-500">
              Tasks <Badge tone="slate">off</Badge>
            </p>
          )}
        </Card>
      )}

      <SectionHeader
        title="Recent calls"
        description={
          isInbound
            ? "Inbound calls appear here once the concierge answers the line."
            : "Calls appear here once the engine starts dialing."
        }
      />
      {calls.length === 0 ? (
        <Card className="p-8 text-center text-sm text-ink-500">
          No calls yet.
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ink-50/80 text-left text-xs font-medium uppercase tracking-wide text-ink-400">
                <tr>
                  <th className="px-5 py-3">When</th>
                  <th className="px-5 py-3">{isInbound ? "Line" : "To"}</th>
                  {!isInbound && <th className="px-5 py-3">Attempt</th>}
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Outcome</th>
                  {!isInbound && <th className="px-5 py-3">Task</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {calls.map((c) => (
                  <tr
                    key={c.id}
                    className="transition-colors hover:bg-ink-50/50"
                  >
                    <td className="px-5 py-3.5 text-ink-500">
                      {new Date(c.queued_at).toLocaleString()}
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs text-ink-700">
                      {c.to_number}
                    </td>
                    {!isInbound && (
                      <td className="px-5 py-3.5 text-ink-700">
                        #{c.attempt_number}
                      </td>
                    )}
                    <td className="px-5 py-3.5">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="px-5 py-3.5 text-ink-700">
                      {c.outcome ?? "—"}
                      {c.in_voicemail && (
                        <span className="ml-1 text-xs text-ink-400">(vm)</span>
                      )}
                    </td>
                    {!isInbound && (
                      <td className="px-5 py-3.5">
                        {c.task_created ? (
                          <Badge tone="green">created</Badge>
                        ) : (
                          <span className="text-ink-300">—</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </PageShell>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">
        {label}
      </dt>
      <dd className="mt-1 font-semibold text-ink-800">{value}</dd>
    </div>
  );
}
