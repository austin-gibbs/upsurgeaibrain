"use client";

// =====================================================================
// The post-call automation trigger editor.
//
// One component backs both "new automation" and "edit an existing one", so the
// two can't drift. It renders the stored trigger shape as a plain form (when /
// then / reliability) and keeps a raw-JSON mode for pasting a trigger straight
// out of the runbook. Validation runs client-side first (see trigger-draft.ts)
// so mistakes land next to the field instead of coming back as a 400.
// =====================================================================
import { useState } from "react";
import { Braces, FlaskConical, LayoutList, Plus, Trash2 } from "lucide-react";
import {
  Badge,
  Banner,
  Button,
  Input,
  Label,
  Pill,
  Segmented,
  Select,
  Switch,
  Textarea,
} from "@/components/ui";
import {
  ACTION_TYPES,
  CALL_OUTCOMES,
  CONDITION_OPERATORS,
  CONTEXT_FIELDS,
  draftFromPayloadJson,
  draftToJson,
  draftToPayload,
  emptyDraft,
  operatorNeedsValue,
  type ActionType,
  type ConditionOperator,
  type LinkMode,
  type TriggerDraft,
  type TriggerPayload,
} from "@/lib/console/trigger-draft";

export type EditorAgent = { id: string; name: string };

/** What a "Test Push" came back with — rendered under the editor's buttons. */
export type TestPushResult = {
  /** Endpoint returned 2xx. */
  delivered: boolean;
  url?: string | null;
  method?: string | null;
  /** The exact body that was sent, for mapping fields on the CRM side. */
  payload?: unknown;
  response_status?: number | null;
  response_body?: string | null;
  duration_ms?: number | null;
  /** Whether the sample data satisfies this automation's own conditions. */
  matched?: boolean | null;
  /** Why nothing was sent (internal notify has no endpoint to call). */
  reason?: string | null;
  warnings?: string[] | null;
  error?: string | null;
};

/* --------------------------- Test push result --------------------------- */
function TestPushPanel({ result }: { result: TestPushResult }) {
  const [copied, setCopied] = useState(false);
  const payloadJson =
    result.payload === undefined ? "" : JSON.stringify(result.payload, null, 2);

  const headline = result.delivered
    ? `Delivered — HTTP ${result.response_status}${
        result.duration_ms ? ` in ${result.duration_ms}ms` : ""
      }`
    : (result.reason ?? result.error ?? "The test push was not delivered.");

  async function copyPayload() {
    try {
      await navigator.clipboard.writeText(payloadJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the JSON is on screen to copy by hand */
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-ink-200/70 bg-surface-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={result.delivered ? "green" : result.reason ? "blue" : "red"}>
          {result.delivered ? "test push sent" : result.reason ? "nothing to send" : "not delivered"}
        </Badge>
        <span className="text-sm text-ink-700">{headline}</span>
      </div>

      {result.url && (
        <p className="truncate text-xs text-ink-500">
          {result.method ?? "POST"} {result.url}
        </p>
      )}

      {result.warnings?.map((w) => (
        <Banner key={w} tone="info">
          {w}
        </Banner>
      ))}

      {payloadJson && (
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <Label>Payload sent</Label>
            <Button variant="ghost" size="sm" onClick={copyPayload}>
              {copied ? "Copied" : "Copy JSON"}
            </Button>
          </div>
          <pre className="max-h-72 overflow-auto rounded-xl bg-ink-900/95 p-3 font-mono text-xs leading-relaxed text-ink-50">
            {payloadJson}
          </pre>
          <p className="mt-2 text-xs text-ink-400">
            Fake values — map these field names in your CRM. A real call sends the same shape
            with the caller&apos;s data (and no <code>test</code> flag).
          </p>
        </div>
      )}

      {result.response_body && (
        <div>
          <Label>Endpoint response</Label>
          <pre className="mt-1.5 max-h-40 overflow-auto rounded-xl border border-ink-200/70 bg-surface p-3 font-mono text-xs leading-relaxed text-ink-600">
            {result.response_body}
          </pre>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label htmlFor={htmlFor} hint={hint}>
        {label}
      </Label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function GroupHeading({ step, title, blurb }: { step: string; title: string; blurb: string }) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-[11px] font-bold text-brand-700">
        {step}
      </span>
      <div>
        <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
        <p className="mt-0.5 text-xs text-ink-500">{blurb}</p>
      </div>
    </div>
  );
}

export function TriggerEditor({
  initial,
  agents,
  submitLabel,
  busy = false,
  onSubmit,
  onTestPush,
  onCancel,
  idPrefix,
}: {
  initial?: TriggerDraft;
  agents: EditorAgent[];
  submitLabel: string;
  busy?: boolean;
  /** Receives the validated payload plus the chosen agent scope ("" = all). */
  onSubmit: (payload: TriggerPayload, agentId: string) => void;
  /**
   * Fire a test push at the configured endpoint with sample data. Takes the
   * draft as it stands, so an automation can be proven before it is saved.
   * Must resolve (never reject) so the failure is rendered like any result.
   */
  onTestPush?: (payload: TriggerPayload, agentId: string) => Promise<TestPushResult>;
  onCancel?: () => void;
  /** Keeps input ids unique when several editors are open at once. */
  idPrefix: string;
}) {
  const [draft, setDraft] = useState<TriggerDraft>(initial ?? emptyDraft());
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestPushResult | null>(null);

  const set = <K extends keyof TriggerDraft>(key: K, value: TriggerDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setError(null);
  };

  const id = (suffix: string) => `${idPrefix}-${suffix}`;
  const needsUrl = draft.actionType !== "internal_notify";

  function toJsonMode() {
    // Deliberately lenient: a half-finished draft should still be viewable as
    // JSON, and saving re-validates either way.
    setJsonText(draftToJson(draft));
    setError(null);
    setJsonMode(true);
  }

  function toFormMode() {
    const loaded = draftFromPayloadJson(jsonText, draft.agentId);
    if (!loaded.ok) {
      setError(loaded.error);
      return;
    }
    setDraft(loaded.draft);
    setError(null);
    setJsonMode(false);
  }

  /** Validate whichever pane is active into an API payload, or surface why not. */
  function currentPayload(): TriggerPayload | null {
    // In JSON mode the textarea is the source of truth — fold it back into the
    // draft first so both modes go through the same validation.
    const source = jsonMode ? draftFromPayloadJson(jsonText, draft.agentId) : null;
    if (source && !source.ok) {
      setError(source.error);
      return null;
    }
    const built = draftToPayload(source ? source.draft : draft);
    if (!built.ok) {
      setError(built.error);
      return null;
    }
    setError(null);
    return built.payload;
  }

  function submit() {
    const payload = currentPayload();
    if (payload) onSubmit(payload, draft.agentId);
  }

  async function testPush() {
    if (!onTestPush) return;
    const payload = currentPayload();
    if (!payload) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await onTestPush(payload, draft.agentId));
    } finally {
      setTesting(false);
    }
  }

  function updateCondition(index: number, patch: Partial<TriggerDraft["conditions"][number]>) {
    setDraft((d) => ({
      ...d,
      conditions: d.conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }));
    setError(null);
  }

  function toggleOutcome(outcome: string) {
    setDraft((d) => ({
      ...d,
      onlyOutcomes: d.onlyOutcomes.includes(outcome)
        ? d.onlyOutcomes.filter((o) => o !== outcome)
        : [...d.onlyOutcomes, outcome],
    }));
    setError(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Segmented
          options={[
            { value: "form", label: "Form" },
            { value: "json", label: "JSON" },
          ]}
          value={jsonMode ? "json" : "form"}
          onChange={(v) => {
            // Re-clicking the active tab must not re-serialize, or it would
            // overwrite unsaved edits in the pane you're already looking at.
            if (v === "json" && !jsonMode) toJsonMode();
            if (v === "form" && jsonMode) toFormMode();
          }}
        />
        <span className="flex items-center gap-1.5 text-xs text-ink-400">
          {jsonMode ? (
            <Braces className="h-3.5 w-3.5" strokeWidth={1.75} />
          ) : (
            <LayoutList className="h-3.5 w-3.5" strokeWidth={1.75} />
          )}
          {jsonMode ? "Raw trigger JSON" : "Guided editor"}
        </span>
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      {jsonMode ? (
        <Textarea
          mono
          rows={22}
          aria-label="Trigger JSON"
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
        />
      ) : (
        <>
          {/* ---------------------------- Basics ---------------------------- */}
          <section>
            <GroupHeading
              step="1"
              title="Basics"
              blurb="What this automation is called and which agents it watches."
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor={id("name")}>
                <Input
                  id={id("name")}
                  value={draft.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="Send requested link"
                />
              </Field>
              <Field label="Applies to" htmlFor={id("agent")}>
                <Select
                  id={id("agent")}
                  value={draft.agentId}
                  onChange={(e) => set("agentId", e.target.value)}
                >
                  <option value="">All agents in this workspace</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                className="sm:col-span-2"
                label="Description"
                hint="optional"
                htmlFor={id("description")}
              >
                <Input
                  id={id("description")}
                  value={draft.description}
                  onChange={(e) => set("description", e.target.value)}
                  placeholder="Caller asked for a link — text it via HighLevel."
                />
              </Field>
            </div>
            <div className="mt-4 flex items-center gap-3 rounded-xl bg-surface-2 px-4 py-3">
              <Switch
                checked={draft.enabled}
                onChange={(v) => set("enabled", v)}
                label="Enabled"
              />
              <div>
                <p className="text-sm font-medium text-ink-800">
                  {draft.enabled ? "Enabled" : "Disabled"}
                </p>
                <p className="text-xs text-ink-500">
                  {draft.enabled
                    ? "Runs on every analyzed call that matches."
                    : "Kept as config but never fires."}
                </p>
              </div>
            </div>
          </section>

          {/* ----------------------------- When ----------------------------- */}
          <section className="border-t border-ink-100 pt-6">
            <GroupHeading
              step="2"
              title="When it fires"
              blurb="Matched against the call's custom_analysis_data, plus outcome, summary, and transcript."
            />

            <div className="mb-4 flex flex-wrap items-center gap-3">
              <span className="text-sm text-ink-600">Match</span>
              <Segmented
                options={[
                  { value: "all", label: "All conditions" },
                  { value: "any", label: "Any condition" },
                ]}
                value={draft.matchType}
                onChange={(v) => set("matchType", v as "all" | "any")}
              />
            </div>

            <div className="space-y-2">
              {draft.conditions.map((c, i) => (
                <div
                  key={i}
                  className="grid gap-2 rounded-xl border border-ink-200/70 bg-surface-2 p-3 sm:grid-cols-[minmax(0,1fr)_170px_minmax(0,1fr)_auto]"
                >
                  <Input
                    aria-label={`Condition ${i + 1} field`}
                    value={c.field}
                    onChange={(e) => updateCondition(i, { field: e.target.value })}
                    placeholder="link_requested"
                  />
                  <Select
                    aria-label={`Condition ${i + 1} operator`}
                    value={c.operator}
                    onChange={(e) =>
                      updateCondition(i, { operator: e.target.value as ConditionOperator })
                    }
                  >
                    {CONDITION_OPERATORS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                  {operatorNeedsValue(c.operator) ? (
                    <Input
                      aria-label={`Condition ${i + 1} value`}
                      value={c.value}
                      onChange={(e) => updateCondition(i, { value: e.target.value })}
                      placeholder={c.operator === "in" ? "buyer_guide, seller_guide" : "buyer_guide"}
                    />
                  ) : (
                    <div className="hidden sm:block" />
                  )}
                  <button
                    type="button"
                    aria-label={`Remove condition ${i + 1}`}
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        conditions: d.conditions.filter((_, idx) => idx !== i),
                      }))
                    }
                    className="flex h-10 w-10 items-center justify-center justify-self-end rounded-xl text-ink-400 transition-colors hover:bg-accent-rose-bg hover:text-accent-rose-fg"
                  >
                    <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    conditions: [...d.conditions, { field: "", operator: "is_true", value: "" }],
                  }))
                }
              >
                <Plus className="h-4 w-4" strokeWidth={2} />
                Add condition
              </Button>
              <p className="text-xs text-ink-400">
                {draft.conditions.length === 0
                  ? "No conditions — fires on every call that passes the outcome filter."
                  : `Context fields: ${CONTEXT_FIELDS.join(", ")}. Anything else reads custom_analysis_data.`}
              </p>
            </div>

            <div className="mt-5">
              <Label>
                Only these outcomes
                <span className="ml-1 font-normal text-ink-400">
                  — leave empty for any outcome
                </span>
              </Label>
              <div className="mt-2 flex flex-wrap gap-2">
                {CALL_OUTCOMES.map((o) => (
                  <Pill
                    key={o}
                    selected={draft.onlyOutcomes.includes(o)}
                    onClick={() => toggleOutcome(o)}
                  >
                    {o}
                  </Pill>
                ))}
              </div>
            </div>
          </section>

          {/* ----------------------------- Then ----------------------------- */}
          <section className="border-t border-ink-100 pt-6">
            <GroupHeading
              step="3"
              title="What it does"
              blurb="The action fired for each match. Runs are retried and logged."
            />

            <div className="grid gap-2 sm:grid-cols-3">
              {ACTION_TYPES.map((a) => {
                const active = draft.actionType === a.value;
                return (
                  <button
                    key={a.value}
                    type="button"
                    onClick={() => set("actionType", a.value as ActionType)}
                    aria-pressed={active}
                    className={
                      "rounded-xl border p-3 text-left transition-all duration-200 " +
                      (active
                        ? "border-brand-500 bg-brand-50 shadow-soft"
                        : "border-ink-200/70 bg-surface hover:border-ink-300")
                    }
                  >
                    <span
                      className={
                        "block text-sm font-semibold " +
                        (active ? "text-brand-700" : "text-ink-800")
                      }
                    >
                      {a.label}
                    </span>
                    <span className="mt-1 block text-xs leading-relaxed text-ink-500">
                      {a.blurb}
                    </span>
                  </button>
                );
              })}
            </div>

            {needsUrl && (
              <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
                <Field label="Delivery URL" htmlFor={id("url")}>
                  <Input
                    id={id("url")}
                    value={draft.url}
                    onChange={(e) => set("url", e.target.value)}
                    placeholder="https://services.leadconnectorhq.com/hooks/…"
                  />
                </Field>
                <Field label="Method" htmlFor={id("method")}>
                  <Select
                    id={id("method")}
                    value={draft.method}
                    onChange={(e) => set("method", e.target.value as TriggerDraft["method"])}
                  >
                    <option value="POST">POST</option>
                    <option value="PUT">PUT</option>
                    <option value="PATCH">PATCH</option>
                  </Select>
                </Field>
              </div>
            )}

            <div className="mt-4">
              <Label>Link to attach</Label>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <Segmented
                  options={[
                    { value: "none", label: "No link" },
                    { value: "field", label: "From the call" },
                    { value: "static", label: "Always the same" },
                  ]}
                  value={draft.linkMode}
                  onChange={(v) => set("linkMode", v as LinkMode)}
                />
                {draft.linkMode === "field" && (
                  <Input
                    aria-label="Analysis field holding the link type"
                    className="sm:max-w-xs"
                    value={draft.linkTypeField}
                    onChange={(e) => set("linkTypeField", e.target.value)}
                    placeholder="link_type"
                  />
                )}
                {draft.linkMode === "static" && (
                  <Input
                    aria-label="Fixed link type"
                    className="sm:max-w-xs"
                    value={draft.staticLinkType}
                    onChange={(e) => set("staticLinkType", e.target.value)}
                    placeholder="buyer_guide"
                  />
                )}
              </div>
              <p className="mt-2 text-xs text-ink-400">
                {draft.linkMode === "field"
                  ? "The call names the link type; the workspace link map resolves it to a URL."
                  : draft.linkMode === "static"
                    ? "Always resolves this link type from the workspace link map."
                    : "No link is resolved for this action."}
              </p>
            </div>

            <Field
              className="mt-4"
              label="Message template"
              hint="optional"
              htmlFor={id("message")}
            >
              <Textarea
                id={id("message")}
                rows={3}
                value={draft.messageTemplate}
                onChange={(e) => set("messageTemplate", e.target.value)}
                placeholder="Hi {{contact.first_name}}, here's the info you asked for: {{link.url}}"
              />
            </Field>
            <p className="mt-2 text-xs text-ink-400">
              Placeholders: {"{{contact.first_name}}"}, {"{{contact.phone}}"}, {"{{link.url}}"},{" "}
              {"{{outcome}}"}, {"{{summary}}"}, {"{{recording_url}}"}, {"{{fields.<name>}}"}. Unknown
              tokens render empty.
            </p>

            <details className="group mt-4 rounded-xl border border-ink-200/70 bg-surface-2 p-4">
              <summary className="cursor-pointer list-none text-sm font-medium text-ink-700 transition-colors hover:text-ink-900">
                Advanced request options
              </summary>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field
                  label="Custom headers"
                  hint="JSON object"
                  htmlFor={id("headers")}
                >
                  <Textarea
                    id={id("headers")}
                    mono
                    rows={5}
                    value={draft.headersJson}
                    onChange={(e) => set("headersJson", e.target.value)}
                    placeholder={'{\n  "Authorization": "Bearer …"\n}'}
                  />
                </Field>
                <Field
                  label="Payload template"
                  hint="replaces the default body"
                  htmlFor={id("payload")}
                >
                  <Textarea
                    id={id("payload")}
                    mono
                    rows={5}
                    value={draft.payloadJson}
                    onChange={(e) => set("payloadJson", e.target.value)}
                    placeholder={'{\n  "phone": "{{contact.phone}}",\n  "text": "{{link.url}}"\n}'}
                  />
                </Field>
              </div>
            </details>
          </section>

          {/* -------------------------- Reliability -------------------------- */}
          <section className="border-t border-ink-100 pt-6">
            <GroupHeading
              step="4"
              title="Reliability"
              blurb="How often the same contact can be hit, and how hard delivery retries."
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Dedupe window"
                hint="hours · 0 never dedupes"
                htmlFor={id("dedupe")}
              >
                <Input
                  id={id("dedupe")}
                  type="number"
                  min={0}
                  max={720}
                  value={draft.dedupeWindowHours}
                  onChange={(e) => set("dedupeWindowHours", e.target.value)}
                />
              </Field>
              <Field label="Max delivery attempts" hint="1–20" htmlFor={id("attempts")}>
                <Input
                  id={id("attempts")}
                  type="number"
                  min={1}
                  max={20}
                  value={draft.maxAttempts}
                  onChange={(e) => set("maxAttempts", e.target.value)}
                />
              </Field>
            </div>
          </section>
        </>
      )}

      <div className="space-y-4 border-t border-ink-100 pt-5">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={submit} disabled={busy || testing}>
            {busy ? "Saving…" : submitLabel}
          </Button>
          {onTestPush && (
            <Button variant="secondary" onClick={testPush} disabled={busy || testing}>
              <FlaskConical className="h-4 w-4" strokeWidth={1.75} />
              {testing ? "Pushing…" : "Test Push"}
            </Button>
          )}
          {onCancel && (
            <Button variant="ghost" onClick={onCancel} disabled={busy || testing}>
              Cancel
            </Button>
          )}
        </div>
        {onTestPush && !testResult && (
          <p className="text-xs text-ink-400">
            Test Push sends this automation&apos;s payload to the delivery URL with fake sample
            data — no call and no save required — so the CRM side can be mapped first.
          </p>
        )}
        {testResult && <TestPushPanel result={testResult} />}
      </div>
    </div>
  );
}
