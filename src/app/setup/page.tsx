"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageShell } from "@/components/TopNav";
import {
  Button,
  Card,
  Input,
  Label,
  Select,
  Badge,
  Tabs,
  PageGreeting,
  cn,
} from "@/components/ui";
import { CallSettings } from "@/components/agent-form/CallSettings";
import { TaskSettings } from "@/components/agent-form/TaskSettings";
import {
  defaultCallConfig,
  defaultTaskConfig,
  type CallConfig,
  type TaskConfig,
} from "@/components/agent-form/types";

/* ------------------------------------------------------------------ */
/* Types mirroring provisionWorkspaceSchema (src/lib/validation.ts)    */
/* ------------------------------------------------------------------ */
type CrmProvider = "followupboss" | "highlevel";

type AgentForm = {
  name: string;
  enroll_tag: string;
  objective: string;
  retell_agent_id: string;
  retell_from_number: string;
  callConfig: CallConfig;
  taskConfig: TaskConfig;
};

function newAgent(i: number, workspaceEnrollTag: string): AgentForm {
  return {
    name: `Agent ${i + 1}`,
    enroll_tag: i === 0 ? workspaceEnrollTag : "",
    objective: "",
    retell_agent_id: "",
    retell_from_number: "",
    callConfig: defaultCallConfig(),
    taskConfig: defaultTaskConfig(),
  };
}

const STEPS = [
  "Workspace",
  "Agents",
  "Call settings",
  "Tasks",
  "Review",
] as const;

/* ------------------------------------------------------------------ */
export default function SetupWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);

  // Step 1 — workspace + CRM
  const [orgName, setOrgName] = useState("");
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("America/New_York");
  const [crmProvider, setCrmProvider] = useState<CrmProvider>("followupboss");
  const [enrollTag, setEnrollTag] = useState("upsurgecallflowai");
  const [fubApiKey, setFubApiKey] = useState("");
  const [hlToken, setHlToken] = useState("");
  const [hlLocation, setHlLocation] = useState("");

  // CRM verification
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [crmUsers, setCrmUsers] = useState<{ id: string; name: string }[]>([]);
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);

  // Step 2+ — agents
  const [agents, setAgents] = useState<AgentForm[]>([newAgent(0, "upsurgecallflowai")]);
  const [activeAgent, setActiveAgent] = useState(0);

  // submit
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  function credentials() {
    return crmProvider === "followupboss"
      ? { apiKey: fubApiKey.trim() }
      : { accessToken: hlToken.trim(), locationId: hlLocation.trim() };
  }

  function setAgentCount(n: number) {
    const count = Math.max(1, Math.min(20, n));
    setAgents((prev) => {
      const next = [...prev];
      while (next.length < count) next.push(newAgent(next.length, enrollTag));
      next.length = count;
      return next;
    });
    if (activeAgent >= count) setActiveAgent(count - 1);
  }

  function updateAgent(i: number, patch: Partial<AgentForm>) {
    setAgents((prev) =>
      prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a))
    );
  }
  function updateCall(i: number, patch: Partial<CallConfig>) {
    setAgents((prev) =>
      prev.map((a, idx) =>
        idx === i ? { ...a, callConfig: { ...a.callConfig, ...patch } } : a
      )
    );
  }
  function updateTask(i: number, patch: Partial<TaskConfig>) {
    setAgents((prev) =>
      prev.map((a, idx) =>
        idx === i ? { ...a, taskConfig: { ...a.taskConfig, ...patch } } : a
      )
    );
  }

  async function verifyCrm() {
    setVerifying(true);
    setVerifyMsg(null);
    setVerified(false);
    try {
      const res = await fetch("/api/crm/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          crm_provider: crmProvider,
          credentials: credentials(),
          includeUsers: true,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setVerified(true);
        setCrmUsers(data.users ?? []);
        setVerifyMsg(
          `Connected${
            data.users?.length ? ` — ${data.users.length} assignable users found` : ""
          }.`
        );
      } else {
        setVerifyMsg(data.error ?? "Verification failed");
      }
    } catch (e: any) {
      setVerifyMsg(e.message ?? "Verification error");
    } finally {
      setVerifying(false);
    }
  }

  const step1Valid =
    name.trim().length > 0 &&
    enrollTag.trim().length > 0 &&
    (crmProvider === "followupboss"
      ? fubApiKey.trim().length >= 10
      : hlToken.trim().length >= 10 && hlLocation.trim().length > 0);

  const step2Valid =
    agents.every((a) => a.name.trim().length > 0 && a.enroll_tag.trim().length > 0) &&
    new Set(agents.map((a) => a.enroll_tag.trim().toLowerCase())).size === agents.length;

  async function submit() {
    setSubmitting(true);
    setSubmitErr(null);
    try {
      const payload = {
        organizationName: orgName.trim() || undefined,
        workspace: {
          name: name.trim(),
          timezone,
          crm_provider: crmProvider,
          enroll_tag: enrollTag.trim(),
          credentials: credentials(),
        },
        agents: agents.map((a) => ({
          name: a.name.trim(),
          enroll_tag: a.enroll_tag.trim() || null,
          objective: a.objective.trim() || null,
          retell_agent_id: a.retell_agent_id.trim() || null,
          retell_from_number: a.retell_from_number.trim() || null,
          callConfig: a.callConfig,
          taskConfig: a.taskConfig,
        })),
      };
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error ?? "Provisioning failed");
      }
      router.push(`/workspaces/${data.workspaceId}`);
    } catch (e: any) {
      setSubmitErr(e.message ?? "Something went wrong");
      setSubmitting(false);
    }
  }

  return (
    <PageShell>
      <div className="mx-auto max-w-3xl">
        <PageGreeting
          title="New workspace"
          subtitle="Provision a client, its CRM connection, and AI voice agents. Agents start in draft — activate them when you're ready to dial."
        />

        {/* Stepper */}
        <ol className="mb-10 flex items-center gap-2">
          {STEPS.map((label, i) => (
            <li key={label} className="flex flex-1 items-center gap-2">
              <span
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-xs font-semibold transition-all",
                  i === step
                    ? "bg-brand-gradient text-white shadow-soft"
                    : i < step
                    ? "bg-accent-sky-bg text-accent-sky-fg"
                    : "bg-ink-100 text-ink-400"
                )}
              >
                {i + 1}
              </span>
              <span
                className={cn(
                  "hidden text-xs font-medium sm:block",
                  i === step ? "text-ink-900" : "text-ink-400"
                )}
              >
                {label}
              </span>
              {i < STEPS.length - 1 && (
                <span className="h-px flex-1 bg-ink-200/80" />
              )}
            </li>
          ))}
        </ol>

        {/* STEP 1 — Workspace */}
        {step === 0 && (
          <Card className="space-y-6 p-6 sm:p-8">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Workspace (client) name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Acme Realty"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Organization name <span className="font-normal text-slate-400">(optional)</span></Label>
                <Input
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder="Your agency"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Timezone</Label>
                <Select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                >
                  {[
                    "America/New_York",
                    "America/Chicago",
                    "America/Denver",
                    "America/Los_Angeles",
                    "America/Phoenix",
                  ].map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label hint="contacts with this tag get called">
                  Enrollment tag
                </Label>
                <Input
                  value={enrollTag}
                  onChange={(e) => {
                    const next = e.target.value;
                    setEnrollTag(next);
                    setAgents((prev) =>
                      prev.map((a, i) =>
                        i === 0 ? { ...a, enroll_tag: next } : a
                      )
                    );
                  }}
                />
              </div>
            </div>

            <hr className="border-ink-100" />

            <div className="space-y-1.5">
              <Label>CRM provider</Label>
              <div className="flex gap-2">
                {(
                  [
                    ["followupboss", "Follow Up Boss"],
                    ["highlevel", "HighLevel"],
                  ] as const
                ).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => {
                      setCrmProvider(val);
                      setVerified(false);
                      setVerifyMsg(null);
                    }}
                    className={cn(
                      "flex-1 rounded-xl border px-4 py-3.5 text-sm font-medium transition-all duration-200",
                      crmProvider === val
                        ? "border-brand-500 bg-accent-sky-bg text-accent-sky-fg shadow-soft"
                        : "border-ink-200/80 bg-white text-ink-600 hover:bg-ink-50"
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {crmProvider === "followupboss" ? (
              <div className="space-y-1.5">
                <Label>Follow Up Boss API key</Label>
                <Input
                  type="password"
                  value={fubApiKey}
                  onChange={(e) => {
                    setFubApiKey(e.target.value);
                    setVerified(false);
                  }}
                  placeholder="fka_…"
                />
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>HighLevel access token</Label>
                  <Input
                    type="password"
                    value={hlToken}
                    onChange={(e) => {
                      setHlToken(e.target.value);
                      setVerified(false);
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Location ID</Label>
                  <Input
                    value={hlLocation}
                    onChange={(e) => {
                      setHlLocation(e.target.value);
                      setVerified(false);
                    }}
                  />
                </div>
              </div>
            )}

            <div className="flex items-center gap-3">
              <Button
                variant="secondary"
                onClick={verifyCrm}
                disabled={!step1Valid || verifying}
              >
                {verifying ? "Verifying…" : "Test connection"}
              </Button>
              {verified && <Badge tone="green">Verified</Badge>}
              {verifyMsg && (
                <span
                  className={`text-sm ${
                    verified ? "text-green-700" : "text-red-600"
                  }`}
                >
                  {verifyMsg}
                </span>
              )}
            </div>
          </Card>
        )}

        {/* STEP 2 — Agent count + identity */}
        {step === 1 && (
          <Card className="space-y-6 p-6 sm:p-8">
            <div className="space-y-1.5">
              <Label hint="Retell voice agents in this workspace">
                How many AI agents?
              </Label>
              <div className="flex items-center gap-3">
                <Button
                  variant="secondary"
                  className="h-9 w-9 p-0"
                  onClick={() => setAgentCount(agents.length - 1)}
                >
                  −
                </Button>
                <span className="w-8 text-center text-lg font-semibold">
                  {agents.length}
                </span>
                <Button
                  variant="secondary"
                  className="h-9 w-9 p-0"
                  onClick={() => setAgentCount(agents.length + 1)}
                >
                  +
                </Button>
              </div>
            </div>

            <hr className="border-ink-100" />

            <div className="space-y-4">
              {agents.map((a, i) => (
                <div
                  key={i}
                  className="rounded-2xl border border-ink-200/60 bg-ink-50/30 p-5"
                >
                  <div className="mb-4 text-xs font-semibold uppercase tracking-wide text-ink-400">
                    Agent {i + 1}
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Name</Label>
                      <Input
                        value={a.name}
                        onChange={(e) =>
                          updateAgent(i, { name: e.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label hint="E.164, e.g. +13055551234">
                        Retell from-number
                      </Label>
                      <Input
                        value={a.retell_from_number}
                        onChange={(e) =>
                          updateAgent(i, {
                            retell_from_number: e.target.value,
                          })
                        }
                        placeholder="+1…"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Retell agent ID</Label>
                      <Input
                        value={a.retell_agent_id}
                        onChange={(e) =>
                          updateAgent(i, {
                            retell_agent_id: e.target.value,
                          })
                        }
                        placeholder="agent_…"
                      />
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label hint="each agent needs a distinct CRM tag">
                        Enrollment tag
                      </Label>
                      <Input
                        value={a.enroll_tag}
                        onChange={(e) =>
                          updateAgent(i, { enroll_tag: e.target.value })
                        }
                        placeholder={i === 0 ? enrollTag : "unique-tag-for-this-agent"}
                      />
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label hint="passed to Retell as a dynamic variable">
                        Objective
                      </Label>
                      <Input
                        value={a.objective}
                        onChange={(e) =>
                          updateAgent(i, { objective: e.target.value })
                        }
                        placeholder="Book a listing appointment"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* STEP 3 — Call settings (per agent) */}
        {step === 2 && (
          <Card className="p-6 sm:p-8">
            <AgentTabs
              agents={agents}
              active={activeAgent}
              onSelect={setActiveAgent}
            />
            <CallSettings
              cfg={agents[activeAgent].callConfig}
              onChange={(patch) => updateCall(activeAgent, patch)}
            />
          </Card>
        )}

        {/* STEP 4 — Tasks (per agent) */}
        {step === 3 && (
          <Card className="p-6 sm:p-8">
            <AgentTabs
              agents={agents}
              active={activeAgent}
              onSelect={setActiveAgent}
            />
            <TaskSettings
              cfg={agents[activeAgent].taskConfig}
              users={crmUsers}
              onChange={(patch) => updateTask(activeAgent, patch)}
            />
          </Card>
        )}

        {/* STEP 5 — Review */}
        {step === 4 && (
          <Card className="space-y-5 p-6 sm:p-8">
            <Review
              workspace={{ name, timezone, crmProvider, enrollTag, verified }}
              agents={agents}
            />
            {submitErr && (
              <p className="rounded-xl bg-accent-rose-bg px-4 py-3 text-sm text-accent-rose-fg">
                {submitErr}
              </p>
            )}
          </Card>
        )}

        {/* Footer nav */}
        <div className="mt-8 flex items-center justify-between">
          <Button
            variant="ghost"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
          >
            ← Back
          </Button>

          {step < STEPS.length - 1 ? (
            <Button
              onClick={() => setStep((s) => s + 1)}
              disabled={
                (step === 0 && !step1Valid) || (step === 1 && !step2Valid)
              }
            >
              Continue →
            </Button>
          ) : (
            <Button onClick={submit} disabled={submitting}>
              {submitting ? "Provisioning…" : "Create workspace"}
            </Button>
          )}
        </div>
      </div>
    </PageShell>
  );
}

/* ------------------------- sub-components ------------------------- */

function AgentTabs({
  agents,
  active,
  onSelect,
}: {
  agents: AgentForm[];
  active: number;
  onSelect: (i: number) => void;
}) {
  return (
    <div className="mb-5">
      <Tabs
      items={agents.map((a, i) => ({
        id: String(i),
        label: a.name || `Agent ${i + 1}`,
      }))}
      active={String(active)}
      onSelect={(id) => onSelect(Number(id))}
      />
    </div>
  );
}

function Review({
  workspace,
  agents,
}: {
  workspace: {
    name: string;
    timezone: string;
    crmProvider: string;
    enrollTag: string;
    verified: boolean;
  };
  agents: AgentForm[];
}) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="mb-3 text-sm font-semibold text-ink-900">Workspace</h3>
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-ink-500">Name</dt>
          <dd className="font-medium text-ink-800">{workspace.name}</dd>
          <dt className="text-ink-500">CRM</dt>
          <dd className="text-ink-800">
            {workspace.crmProvider === "followupboss"
              ? "Follow Up Boss"
              : "HighLevel"}{" "}
            {workspace.verified && <Badge tone="green">verified</Badge>}
          </dd>
          <dt className="text-ink-500">Timezone</dt>
          <dd className="text-ink-800">{workspace.timezone}</dd>
          <dt className="text-ink-500">Enroll tag</dt>
          <dd className="font-mono text-xs text-ink-800">
            {workspace.enrollTag}
          </dd>
        </dl>
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-ink-900">
          {agents.length} agent{agents.length > 1 ? "s" : ""}
        </h3>
        <div className="space-y-2">
          {agents.map((a, i) => (
            <div
              key={i}
              className="rounded-xl border border-ink-200/60 bg-ink-50/30 p-4 text-sm"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-ink-800">{a.name}</span>
                <span className="text-ink-400">
                  {a.enroll_tag} · {a.callConfig.max_calls_per_day}/day ·{" "}
                  {a.callConfig.max_attempts_per_contact} attempts ·{" "}
                  {a.taskConfig.enabled ? "tasks on" : "no tasks"}
                </span>
              </div>
              {!a.retell_agent_id && (
                <p className="mt-1 text-xs text-accent-amber-fg">
                  No Retell agent ID — you can add it before activating.
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      <p className="rounded-xl bg-ink-100/80 px-4 py-3 text-xs text-ink-500">
        Agents are created in <span className="font-medium">draft</span>. Open
        the workspace afterward to activate them and start dialing.
      </p>
    </div>
  );
}
