"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Phone, Settings, KeyRound } from "lucide-react";
import { CallSettings } from "@/components/agent-form/CallSettings";
import { TaskSettings } from "@/components/agent-form/TaskSettings";
import { PostCallWebhookSettings } from "@/components/agent-form/PostCallWebhookSettings";
import { HighLevelOpportunityFieldSettings } from "@/components/agent-form/HighLevelOpportunityFieldSettings";
import { PipelineStageSettings } from "@/components/agent-form/PipelineStageSettings";
import {
  defaultCallConfig,
  defaultTaskConfig,
  type CallConfig,
  type OpportunityCustomField,
  type Pipeline,
  type StageMapEntry,
  type TaskConfig,
} from "@/components/agent-form/types";
import { normalizeHHMM, normalizeTaskConfigList } from "@/lib/hhmm";
import {
  prepareStageMapForSave,
  prepareTaskConfigForSave,
  stageMapFromRows,
  taskConfigFromRow,
  validateStageMapForSave,
  validateTaskConfigForSave,
} from "@/lib/task-config";
import { outcomeLabel } from "@/lib/engine/outcome";
import type { CallOutcome } from "@/types";
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
  cn,
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
  const [taskActionMsg, setTaskActionMsg] = useState<string | null>(null);

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
  const [callCfg, setCallCfg] = useState<CallConfig>(defaultCallConfig());
  const [taskCfg, setTaskCfg] = useState<TaskConfig>(defaultTaskConfig());
  const [workspaceTimezone, setWorkspaceTimezone] = useState("America/New_York");
  // Effective CRM = agent's own provider/creds, else inherited from workspace.
  // Drives the HighLevel-only routing editor so it also shows for older
  // workspaces that configured HighLevel at the workspace level.
  const [effectiveCrmProvider, setEffectiveCrmProvider] =
    useState<CrmProvider | null>(null);
  const [hasEffectiveCrmCredentials, setHasEffectiveCrmCredentials] =
    useState(false);
  const [crmStatus, setCrmStatus] = useState<string | null>(null);
  const [stageMap, setStageMap] = useState<StageMapEntry[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [pipelinesLoading, setPipelinesLoading] = useState(false);
  const [pipelinesError, setPipelinesError] = useState<string | null>(null);
  const [opportunityFields, setOpportunityFields] = useState<OpportunityCustomField[]>([]);
  const [opportunityFieldsLoading, setOpportunityFieldsLoading] = useState(false);
  const [opportunityFieldsError, setOpportunityFieldsError] = useState<string | null>(null);
  const [crmUsers, setCrmUsers] = useState<{ id: string; name: string }[]>([]);
  const [crmUsersLoading, setCrmUsersLoading] = useState(false);

  const isHighLevel = effectiveCrmProvider === "highlevel";

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
        setCrmProvider(
          d.agent.crm_provider ?? d.effectiveCrmProvider ?? "followupboss"
        );
        setFubApiKey("");
        setHlAccessToken("");
        setHlLocationId("");
        setRetellApiKey("");
        setRetellWebhookSecret("");
        const cc = d.agent.agent_call_configs?.[0];
        if (cc) {
          setCallCfg({
            max_total_calls: cc.max_total_calls ?? null,
            max_calls_per_day: cc.max_calls_per_day ?? 100,
            max_attempts_per_contact: cc.max_attempts_per_contact ?? 10,
            call_window_start: normalizeHHMM(cc.call_window_start ?? "09:00"),
            call_window_end: normalizeHHMM(cc.call_window_end ?? "18:00"),
            daily_run_at: normalizeHHMM(cc.daily_run_at ?? "09:00"),
            drip_seconds: cc.drip_seconds ?? 60,
            cadence_day_gaps: cc.cadence_day_gaps ?? defaultCallConfig().cadence_day_gaps,
          });
        } else {
          setCallCfg(defaultCallConfig());
        }
        const tc = normalizeTaskConfigList(d.agent.agent_task_configs)[0];
        if (tc) {
          setTaskCfg(taskConfigFromRow(tc));
        } else {
          setTaskCfg(defaultTaskConfig());
        }
        setStageMap(stageMapFromRows(d.pipelineStageMap ?? []));
        setWorkspaceTimezone(d.workspaceTimezone ?? "America/New_York");
        setEffectiveCrmProvider(d.effectiveCrmProvider ?? null);
        setHasEffectiveCrmCredentials(Boolean(d.hasEffectiveCrmCredentials));
        setCrmStatus(d.effectiveCrmStatus ?? null);
      })
      .catch((e) => setError(e.message));
  }

  useEffect(load, [params.id]);

  // Surface the CRM OAuth callback result (redirects back with ?crm=).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("crm");
    if (status === "connected") {
      setActionMsg("HighLevel connected — token will auto-refresh.");
    } else if (status === "error") {
      const reason = params.get("reason");
      setActionMsg(
        reason
          ? `HighLevel connection failed: ${reason}`
          : "HighLevel connection was cancelled or failed."
      );
    }
  }, []);

  // Pull HighLevel pipelines + stages for the routing UI. Callable on demand
  // (the "Refresh" button) so a user can re-sync after editing pipelines or
  // stages in HighLevel, without reloading the page. No-op unless the effective
  // CRM (agent's own or inherited from the workspace) is HighLevel with creds.
  const loadPipelines = useCallback(() => {
    if (effectiveCrmProvider !== "highlevel" || !hasEffectiveCrmCredentials) {
      setPipelines([]);
      return;
    }
    setPipelinesLoading(true);
    setPipelinesError(null);
    fetch(`/api/agents/${params.id}/pipelines`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error && !d.pipelines) setPipelinesError(d.error);
        setPipelines(d.pipelines ?? []);
      })
      .catch((e) => setPipelinesError(e.message))
      .finally(() => setPipelinesLoading(false));
  }, [effectiveCrmProvider, hasEffectiveCrmCredentials, params.id]);

  useEffect(() => {
    loadPipelines();
  }, [loadPipelines]);

  const loadOpportunityFields = useCallback(() => {
    if (effectiveCrmProvider !== "highlevel" || !hasEffectiveCrmCredentials) {
      setOpportunityFields([]);
      return;
    }
    setOpportunityFieldsLoading(true);
    setOpportunityFieldsError(null);
    fetch(`/api/agents/${params.id}/opportunity-fields`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error && !d.fields) setOpportunityFieldsError(d.error);
        setOpportunityFields(d.fields ?? []);
      })
      .catch((e) => setOpportunityFieldsError(e.message))
      .finally(() => setOpportunityFieldsLoading(false));
  }, [effectiveCrmProvider, hasEffectiveCrmCredentials, params.id]);

  useEffect(() => {
    loadOpportunityFields();
  }, [loadOpportunityFields]);

  const loadCrmUsers = useCallback(() => {
    if (!hasEffectiveCrmCredentials) {
      setCrmUsers([]);
      return;
    }
    setCrmUsersLoading(true);
    fetch(`/api/agents/${params.id}/users`)
      .then((r) => r.json())
      .then((d) => setCrmUsers(d.users ?? []))
      .catch(() => setCrmUsers([]))
      .finally(() => setCrmUsersLoading(false));
  }, [hasEffectiveCrmCredentials, params.id]);

  useEffect(() => {
    loadCrmUsers();
  }, [loadCrmUsers]);

  function applySavedTaskSettings(
    data: {
      taskConfig?: Record<string, unknown>;
      pipelineStageMap?: Record<string, unknown>[];
    },
    fallback?: {
      taskConfig: TaskConfig;
      stageMap?: StageMapEntry[];
    }
  ) {
    if (fallback?.taskConfig) {
      setTaskCfg(fallback.taskConfig);
      setAgent((prev) =>
        prev
          ? {
              ...prev,
              agent_task_configs: [fallback.taskConfig],
            }
          : prev
      );
    } else if (data.taskConfig) {
      const nextTaskCfg = taskConfigFromRow(data.taskConfig);
      setTaskCfg(nextTaskCfg);
      setAgent((prev) =>
        prev
          ? {
              ...prev,
              agent_task_configs: [data.taskConfig!],
            }
          : prev
      );
    }

    if (fallback?.stageMap) {
      setStageMap(fallback.stageMap);
    } else if (data.pipelineStageMap) {
      setStageMap(stageMapFromRows(data.pipelineStageMap));
    }
  }

  async function patch(
    body: Record<string, unknown>,
    opts?: {
      refresh?: boolean;
      feedback?: "task" | "global";
      savedTaskSettings?: { taskConfig: TaskConfig; stageMap?: StageMapEntry[] };
    }
  ) {
    const feedback = opts?.feedback ?? "global";
    const setFeedback = feedback === "task" ? setTaskActionMsg : setActionMsg;
    setSaving(true);
    setActionMsg(null);
    setTaskActionMsg(null);
    try {
      const res = await fetch(`/api/agents/${params.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        const detail =
          Array.isArray(data.issues) && data.issues.length > 0
            ? data.issues
                .map((issue: { message?: string }) => issue.message)
                .filter(Boolean)
                .join(" ")
            : null;
        throw new Error(detail ?? data.error ?? "Failed");
      }
      const refresh = opts?.refresh ?? true;
      applySavedTaskSettings(data, opts?.savedTaskSettings);
      if (refresh) {
        load();
      }
      if (data.queueRescheduled > 0) {
        setFeedback(
          `Saved. Rescheduled ${data.queueRescheduled} queued call${data.queueRescheduled === 1 ? "" : "s"} to the new window.`
        );
      } else {
        setFeedback("Saved.");
      }
    } catch (e: any) {
      setFeedback(e.message);
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

  function saveCallSettings() {
    patch({
      call_config: {
        ...callCfg,
        call_window_start: normalizeHHMM(callCfg.call_window_start),
        call_window_end: normalizeHHMM(callCfg.call_window_end),
        daily_run_at: normalizeHHMM(callCfg.daily_run_at),
        max_calls_per_day:
          callCfg.max_calls_per_day >= 1 ? callCfg.max_calls_per_day : 100,
        max_attempts_per_contact:
          callCfg.max_attempts_per_contact >= 1
            ? callCfg.max_attempts_per_contact
            : 10,
        drip_seconds: callCfg.drip_seconds >= 1 ? callCfg.drip_seconds : 60,
      },
    });
  }

  function saveTaskSettings() {
    const prepared = prepareTaskConfigForSave(taskCfg);
    const preparedStageMap = prepareStageMapForSave(stageMap);
    const validationError =
      validateTaskConfigForSave(prepared) ??
      validateStageMapForSave(stageMap, prepared.pipeline_automation_enabled);
    if (validationError) {
      setTaskActionMsg(validationError);
      return;
    }
    const body: Record<string, unknown> = { task_config: prepared };
    if (isHighLevel) {
      body.pipeline_stage_map =
        prepared.pipeline_automation_enabled && preparedStageMap.length > 0
          ? preparedStageMap
          : [];
    }
    patch(body, {
      refresh: false,
      feedback: "task",
      savedTaskSettings: {
        taskConfig: prepared,
        ...(isHighLevel
          ? {
              stageMap:
                prepared.pipeline_automation_enabled && preparedStageMap.length > 0
                  ? preparedStageMap
                  : [],
            }
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
  const tc = normalizeTaskConfigList(agent.agent_task_configs)[0];

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
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-ink-400" />
              <h2 className="text-sm font-semibold text-ink-900">CRM</h2>
            </div>
            {crmStatus === "needs_reauth" && (
              <Badge tone="red">Reconnect needed</Badge>
            )}
          </div>
          {crmStatus === "needs_reauth" && (
            <p className="rounded-xl bg-accent-rose-bg px-3 py-2 text-xs text-accent-rose-fg">
              The HighLevel connection expired and calls for this agent will fail
              until you reconnect. Click “Connect via OAuth” below to restore it.
            </p>
          )}
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
          {crmProvider === "highlevel" && (
            <a
              href={`/api/agents/${params.id}/crm/connect`}
              className="block w-full rounded-xl border border-ink-200 px-4 py-2 text-center text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50"
            >
              Connect via OAuth
            </a>
          )}
          {crmProvider === "highlevel" && (
            <p className="text-xs text-ink-500">
              OAuth keeps the HighLevel token fresh automatically. Pasting an
              access token works too, but it will expire and stop syncing.
            </p>
          )}
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
        <Card className="mt-6 space-y-5 p-6">
          <SectionHeader
            title="Call settings"
            description={`Dialing rules for this agent. Times use workspace timezone (${workspaceTimezone}).`}
          />
          <CallSettings
            cfg={callCfg}
            onChange={(patch) => setCallCfg((prev) => ({ ...prev, ...patch }))}
          />
          <Button variant="secondary" disabled={saving} onClick={saveCallSettings}>
            Save call settings
          </Button>
        </Card>
      )}

      {!isInbound && (
        <Card className="mt-6 space-y-5 p-6">
          <SectionHeader
            title="Tasks & automations"
            description="Post-call CRM tasks, HighLevel workflow webhooks, poll-stage routing, opportunity custom fields, and outcome-based pipeline routing."
          />
          <TaskSettings
            cfg={taskCfg}
            users={crmUsers}
            onChange={(p) => setTaskCfg((c) => ({ ...c, ...p }))}
          />
          {crmUsersLoading && (
            <p className="text-xs text-ink-500">Loading CRM users for assignee…</p>
          )}
          {isHighLevel && (
            <PostCallWebhookSettings
              cfg={taskCfg}
              onChange={(p) => setTaskCfg((c) => ({ ...c, ...p }))}
            />
          )}
          {isHighLevel && (
            <HighLevelOpportunityFieldSettings
              cfg={taskCfg}
              fields={opportunityFields}
              loading={opportunityFieldsLoading}
              error={opportunityFieldsError}
              onChange={(p) => setTaskCfg((c) => ({ ...c, ...p }))}
              onRefresh={loadOpportunityFields}
            />
          )}
          {isHighLevel && (
            <PipelineStageSettings
              cfg={taskCfg}
              pipelines={pipelines}
              map={stageMap}
              loading={pipelinesLoading}
              error={pipelinesError}
              onChange={(p) => setTaskCfg((c) => ({ ...c, ...p }))}
              onChangeMap={setStageMap}
              onRefresh={loadPipelines}
            />
          )}
          {taskActionMsg && (
            <p
              className={cn(
                "rounded-xl px-4 py-2.5 text-sm",
                taskActionMsg.toLowerCase().includes("saved")
                  ? "bg-accent-mint-bg text-accent-mint-fg"
                  : "bg-accent-rose-bg text-accent-rose-fg"
              )}
            >
              {taskActionMsg}
            </p>
          )}
          <Button variant="secondary" disabled={saving} onClick={saveTaskSettings}>
            Save tasks & automations
          </Button>
          {Boolean(tc?.enabled) && (
            <p className="text-xs text-ink-500">
              Tasks currently <Badge tone="green">on</Badge>
              {typeof tc.assignee_label === "string" && tc.assignee_label
                ? ` → ${tc.assignee_label}`
                : ""}
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
                      {c.outcome ? outcomeLabel(c.outcome as CallOutcome) : "—"}
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
