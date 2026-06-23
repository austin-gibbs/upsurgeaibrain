"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageShell } from "@/components/TopNav";
import {
  Button,
  Card,
  Input,
  Label,
  PageGreeting,
  SectionHeader,
  Segmented,
  Select,
} from "@/components/ui";
import { CallSettings } from "@/components/agent-form/CallSettings";
import { TaskSettings } from "@/components/agent-form/TaskSettings";
import { PostCallWebhookSettings } from "@/components/agent-form/PostCallWebhookSettings";
import {
  defaultCallConfig,
  defaultTaskConfig,
  type CallConfig,
  type TaskConfig,
} from "@/components/agent-form/types";

type Direction = "inbound" | "outbound";
type CrmProvider = "followupboss" | "highlevel";

export default function NewAgentPage({
  params,
}: {
  params: { id: string };
}) {
  const router = useRouter();

  const [direction, setDirection] = useState<Direction>("outbound");
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");

  // Outbound-only
  const [enrollTag, setEnrollTag] = useState("");
  const [retellFromNumber, setRetellFromNumber] = useState("");

  // Retell linkage (both directions need the agent id; inbound also needs creds)
  const [retellAgentId, setRetellAgentId] = useState("");
  const [retellApiKey, setRetellApiKey] = useState("");
  const [retellWebhookSecret, setRetellWebhookSecret] = useState("");

  // CRM (per agent)
  const [crmProvider, setCrmProvider] = useState<CrmProvider>("followupboss");
  const [fubApiKey, setFubApiKey] = useState("");
  const [hlAccessToken, setHlAccessToken] = useState("");
  const [hlLocationId, setHlLocationId] = useState("");

  const [callConfig, setCallConfig] = useState<CallConfig>(defaultCallConfig());
  const [taskConfig, setTaskConfig] = useState<TaskConfig>(defaultTaskConfig());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isInbound = direction === "inbound";

  const crmCredsValid =
    crmProvider === "followupboss"
      ? fubApiKey.trim().length >= 10
      : hlAccessToken.trim().length >= 10 && hlLocationId.trim().length > 0;

  const directionValid = isInbound
    ? retellAgentId.trim().length > 0 && retellApiKey.trim().length >= 10
    : enrollTag.trim().length > 0;

  const valid = name.trim().length > 0 && crmCredsValid && directionValid;

  function crmCredentials() {
    return crmProvider === "followupboss"
      ? { apiKey: fubApiKey.trim() }
      : { accessToken: hlAccessToken.trim(), locationId: hlLocationId.trim() };
  }

  async function submit() {
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${params.id}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          direction,
          objective: objective.trim() || null,
          enroll_tag: isInbound ? null : enrollTag.trim(),
          retell_agent_id: retellAgentId.trim() || null,
          retell_from_number: isInbound ? null : retellFromNumber.trim() || null,
          crm_provider: crmProvider,
          crm_credentials: crmCredentials(),
          retell_credentials: isInbound
            ? {
                apiKey: retellApiKey.trim(),
                ...(retellWebhookSecret.trim()
                  ? { webhookSecret: retellWebhookSecret.trim() }
                  : {}),
              }
            : null,
          callConfig,
          taskConfig,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error ?? "Failed to create agent");
      }
      router.push(`/agents/${data.agentId}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setSubmitting(false);
    }
  }

  return (
    <PageShell>
      <Link
        href={`/workspaces/${params.id}`}
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-ink-500 transition-colors hover:text-ink-700"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to workspace
      </Link>

      <PageGreeting
        title="Add agent"
        subtitle="Choose whether this agent dials out on a cadence or answers the business line — the rest of the setup adapts to that choice."
      />

      <div className="mx-auto max-w-3xl space-y-6">
        {/* Direction */}
        <Card className="space-y-4 p-6 sm:p-8">
          <SectionHeader title="Agent type" />
          <div className="space-y-2">
            <Segmented<Direction>
              value={direction}
              onChange={setDirection}
              options={[
                { value: "outbound", label: "Outbound — dials contacts" },
                { value: "inbound", label: "Inbound — answers the line" },
              ]}
            />
            <p className="text-sm text-ink-500">
              {isInbound
                ? "Inbound agents answer incoming calls. We document each call into the CRM and notify your team — no dialing cadence or enrollment tag needed."
                : "Outbound agents call enrolled contacts on a cadence. They need an enrollment tag and a from-number."}
            </p>
          </div>
        </Card>

        {/* Identity */}
        <Card className="space-y-6 p-6 sm:p-8">
          <SectionHeader title="Identity" />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={isInbound ? "Call concierge" : "Probate follow-up"}
              />
            </div>

            {!isInbound && (
              <div className="space-y-1.5">
                <Label hint="CRM tag that enrolls contacts into this agent's flow">
                  Enrollment tag
                </Label>
                <Input
                  value={enrollTag}
                  onChange={(e) => setEnrollTag(e.target.value)}
                  placeholder="upsurge-probate-ai"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label hint={isInbound ? "required for inbound" : undefined}>
                Retell agent ID
              </Label>
              <Input
                value={retellAgentId}
                onChange={(e) => setRetellAgentId(e.target.value)}
                placeholder="agent_…"
              />
            </div>

            {!isInbound && (
              <div className="space-y-1.5">
                <Label hint="E.164, e.g. +13055551234">Retell from-number</Label>
                <Input
                  value={retellFromNumber}
                  onChange={(e) => setRetellFromNumber(e.target.value)}
                  placeholder="+1…"
                />
              </div>
            )}

            <div className="space-y-1.5 sm:col-span-2">
              <Label hint="passed to Retell as a dynamic variable">Objective</Label>
              <Input
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder={
                  isInbound ? "Greet, qualify, and route callers" : "Book a listing appointment"
                }
              />
            </div>
          </div>
        </Card>

        {/* CRM */}
        <Card className="space-y-6 p-6 sm:p-8">
          <SectionHeader
            title="CRM"
            description="Where this agent reads and writes contacts, notes, tags, and tasks."
          />
          <div className="grid gap-4 sm:grid-cols-2">
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

            {crmProvider === "followupboss" ? (
              <div className="space-y-1.5">
                <Label hint="HTTP Basic — stored encrypted">API key</Label>
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
                  <Label hint="stored encrypted">Access token</Label>
                  <Input
                    type="password"
                    value={hlAccessToken}
                    onChange={(e) => setHlAccessToken(e.target.value)}
                    placeholder="eyJ…"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Location ID</Label>
                  <Input
                    value={hlLocationId}
                    onChange={(e) => setHlLocationId(e.target.value)}
                    placeholder="loc_…"
                  />
                </div>
              </>
            )}
          </div>
        </Card>

        {/* Retell credentials — inbound only */}
        {isInbound && (
          <Card className="space-y-6 p-6 sm:p-8">
            <SectionHeader
              title="Retell credentials"
              description="This agent's Retell account. Stored encrypted, used to verify and process inbound calls."
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label hint="stored encrypted">Retell API key</Label>
                <Input
                  type="password"
                  value={retellApiKey}
                  onChange={(e) => setRetellApiKey(e.target.value)}
                  placeholder="key_…"
                />
              </div>
              <div className="space-y-1.5">
                <Label hint="optional — webhook signing secret">Webhook secret</Label>
                <Input
                  type="password"
                  value={retellWebhookSecret}
                  onChange={(e) => setRetellWebhookSecret(e.target.value)}
                  placeholder="whsec_…"
                />
              </div>
            </div>
          </Card>
        )}

        {/* Outbound-only cadence + tasks */}
        {!isInbound && (
          <>
            <Card className="space-y-6 p-6 sm:p-8">
              <SectionHeader title="Call settings" />
              <CallSettings
                cfg={callConfig}
                onChange={(p) => setCallConfig((c) => ({ ...c, ...p }))}
              />
            </Card>

            <Card className="space-y-6 p-6 sm:p-8">
              <SectionHeader title="Tasks" />
              <TaskSettings
                cfg={taskConfig}
                users={[]}
                onChange={(p) => setTaskConfig((c) => ({ ...c, ...p }))}
              />
              {crmProvider === "highlevel" && (
                <PostCallWebhookSettings
                  cfg={taskConfig}
                  onChange={(p) => setTaskConfig((c) => ({ ...c, ...p }))}
                />
              )}
            </Card>
          </>
        )}

        {error && (
          <p className="rounded-xl bg-accent-rose-bg px-4 py-3 text-sm text-accent-rose-fg">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-3">
          <Link href={`/workspaces/${params.id}`}>
            <Button variant="ghost">Cancel</Button>
          </Link>
          <Button onClick={submit} disabled={!valid || submitting}>
            {submitting ? "Creating…" : "Create agent"}
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
