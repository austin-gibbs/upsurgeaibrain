# UpSurge — Automation & Fulfillment Roadmap

_Goal: make onboarding a new client and running the service hands-off — so fulfillment turnaround is automated end to end, either inside the app or driven by an agent (Cowork/Claude). Ordered by leverage._

The single biggest lever: **today, standing up a client still requires manual steps** — building the Retell agent, creating CRM tags, pasting agent IDs. Most of the items below collapse that into a repeatable, near-instant pipeline.

---

## 1. One-click client onboarding (the fulfillment-turnaround win)

The provisioning API (`POST /api/workspaces`) already creates the workspace, seeds the 7-tag taxonomy, and builds agents + configs. Close the remaining manual gaps so a new client goes live in minutes, not a day:

- **Auto-provision the Retell agent from a template.** Instead of pasting a `retell_agent_id`, call Retell's create-agent API to clone a base "UpSurge outbound" agent and inject the client's business name, objective, and from-number. No more hand-building agents per client.
- **Bootstrap CRM tags programmatically.** On provision, ensure the enroll tag and the 7 outcome tags exist in the client's CRM (create if missing) so the very first poll works without manual tag setup.
- **CRM connect with live verification in the wizard.** FUB = paste API key; HighLevel = OAuth. Verify before save (already done for FUB key) and surface a green check.
- **Demo call on setup.** End the wizard by placing one call to the client's own phone so they hear the agent immediately.
- **Make provisioning transactional** (REVIEW M4) so a half-built client never exists.

**Outcome:** "new client → live calling" drops from hours of manual wiring to a single guided flow.

## 2. Agent-driven fulfillment (the "through you" path)

- **An onboarding script/skill** that takes a client's CRM credentials + a short business profile and runs the entire section-1 pipeline, then reports back what it built. This is the Cowork-native version of fulfillment — you hand off a new client and the agent provisions them.
- **Daily ops digest** (scheduled task): per-client calls placed, outcome mix, errors, agents that didn't poll — pushed to Slack/email each morning so you manage by exception.
- **Self-healing checks**: a scheduled task that verifies each active agent polled today and the webhook endpoint is reachable, and alerts if not.

## 3. Reliability & observability (productionize before scaling volume)

- **Alerting on failures.** Wire the worker's `failed` handlers to a Slack webhook (call failures, poll failures, decrypt failures). Right now failures only hit `console`.
- **Webhook idempotency hardening** (REVIEW H2) — claim-before-side-effects so retries can't duplicate notes/tasks.
- **Status dashboard**: queued / dialing / completed / failed per workspace, last-poll-time per agent, stuck-contact detector (enrolled but no call in N days).
- **Structured logs** with workspace/agent/contact IDs for traceability.

## 4. CRM breadth & robustness

- **HighLevel OAuth token refresh** (REVIEW H3) — required to onboard any HighLevel client.
- **Tag delta writes** (REVIEW M2) — stop clobbering human-added CRM tags.
- **More CRMs via the existing `CrmAdapter` contract** (HubSpot, Salesforce, agency GoHighLevel). The engine doesn't change — only a new adapter + enum entry — so each new CRM widens your addressable market cheaply.

## 5. Agent intelligence (your differentiator — currently stubbed)

- **Turn on the V2 memory LLM.** `summarizeForMemory` and `extractFacts` fall back to deterministic stubs unless `ANTHROPIC_API_KEY` is set. The rolling per-contact memory is the headline feature and it's not actually running — wire the key.
- **Per-vertical fact schemas.** `FACT_KEYS` is hardcoded to probate/inherited-property. Make the fact schema per-agent or per-vertical so the product fits other niches (roofing, solar, insurance).
- **Cadence & prompt experiments** per workspace (A/B day-gaps, scripts) with outcome tracking, so you can prove lift.

## 6. Client-facing surface (retention + pricing)

- **Branded client portal**: expose the existing reporting read-only per workspace so clients self-serve their results.
- **Automated weekly client report** (PDF/email via scheduled task) — "here's what your AI agent did this week."
- **Usage metering** (calls placed, talk minutes) to support productized, per-seat or per-call pricing.

## 7. Compliance & safety (do before high volume)

- **Per-state calling hours.** The 9am–7pm guard is hardcoded to Eastern. Multi-timezone client lists need each contact called within *their* local legal window, not the workspace's.
- **DNC / suppression list** and consent tracking — scrub against internal + national DNC before dialing; honor `dnd` permanently across agents.
- **Number reputation protection**: per-from-number rate caps and spam-label monitoring so your caller IDs don't get flagged.
- **Recording disclosure** handling per jurisdiction.

---

## Suggested sequencing

1. **This week (post-launch):** REVIEW criticals → alerting (3) → turn on memory LLM (5).
2. **Next:** one-click onboarding + Retell templating + CRM tag bootstrap (1) — this is the turnaround-time unlock.
3. **Then:** HighLevel OAuth refresh (4) to open the second CRM, client portal + weekly report (6).
4. **Before scaling volume:** per-state hours + DNC + number reputation (7).
