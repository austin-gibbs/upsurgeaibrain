# American Family / Laine Matthews — "Policy PathFinder" Outbound Transfer Agent (runbook)

A **new UpSurge workspace** + a **new outbound Retell agent** ("Policy PathFinder," voiced as
"Riley") that calls homeowners in hard-to-insure mountain areas (Show Low / White Mountains and
similar) and, **only on explicit consent**, **warm-transfers** them to a licensed agent for a
free home/cabin insurance quote. CRM is **HighLevel**. The target city is pulled per-contact
from the HighLevel **City** field into the prompt as `{{city}}`.

## Status: 🟡 DRAFTED — awaiting your approval, then provision (per your choice: "script first, then provision")

Nothing has been created in Retell or the app yet. This folder holds the ready-to-provision
spec + the approved prompt. Grounded in the mailer you're sending these homeowners
(Laine Matthews & Associates / American Family — "carriers are non-renewing / not writing /
raising prices; we can write new policies in your area; specializes in mountain homes & cabins").

## The brief (what this agent is)

| Setting | Value |
| --- | --- |
| Agent name | `American Family \| Policy PathFinder (Outbound Transfer)` |
| Persona / voice name | "Riley" with **Policy PathFinder** |
| Direction | **Outbound** |
| Objective | Offer a free, no-obligation quote and **warm-transfer, only on explicit consent**, to a licensed agent |
| Transfer target | **+1 435-288-7434** (`+14352887434`) |
| CRM | **HighLevel** (connect after provisioning) |
| City variable | HighLevel **standard City** field → `{{city}}` (auto-merged by `caller.ts`) |
| Enroll tag | `upsurge.amfam.transfer` (tag a HighLevel contact with this to enroll them) |
| Never | discloses/hints at any rate, price, or savings |
| Never | transfers without a clear, explicit "yes" |

## The two guardrails, and how they're enforced

1. **No rate disclosure.** The prompt's "TWO HARD RULES" + a dedicated PRICE DEFLECTION block
   forbid any number, range, percentage, or "you'll save…" — all pricing is deferred to the
   licensed agent. The voicemail script also omits price.
2. **No transfer without consent.** A single **TRANSFER CONSENT GATE** is the only path to the
   `transfer_to_agent` function. It requires an explicit yes to "Would you like me to connect you
   now?"; "maybe," a question, or silence is defined as *not* a yes and forces a re-ask. The
   agent can only reach the gate after the person expresses interest in the free quote.

## Files

- `pathfinder-agent-prompt.md` — canonical Retell `general_prompt` + begin message, the live
  transfer tool config, and the outcome mapping. **This is the source of truth for the prompt.**
- `provision-spec.json` — the provisioning spec (run with `npm run provision:agent`). The prompt +
  begin message are embedded (generated from the prompt doc, so they match exactly). Fill in the
  new Retell API key before running.
- `transfer-tool.json` — the `transfer_to_agent` Retell tool definition to add to the LLM after
  provisioning (Retell tools aren't part of the provision spec).

## Provisioning steps (run locally in the UpSurge repo — needs `.env.local` + network)

> The Cowork sandbox can't reach Retell/Supabase/HighLevel, so run these from your machine
> (Cursor/terminal) where `.env.local` and a same-platform `node_modules` exist.

**1. Create the new Retell workspace** in the Retell dashboard for American Family, and copy its
**API key**. Paste it into `provision-spec.json` → `retell.apiKey` (replace the placeholder). This
is the "new Retell AI workspace" you asked for; keeping it separate keeps American Family's calls,
numbers, and billing isolated from your other clients.

**2. Confirm the new app workspace settings.** `provision-spec.json` uses `workspace.mode: "new"`
with `organizationName: "American Family Insurance"`, `crmProvider: "highlevel"`, and
`ownerEmail: "austin@upsurgecrmpros.com"`. CRM credentials are intentionally omitted so the agent
lands as **draft** until you connect HighLevel in the app (recommended — verify the prompt/voice
and place a test call first).

**3. Set the caller-ID area code.** `retell.phone.areaCode` defaults to **928** (Show Low / White
Mountains) so caller ID looks local. Change it per market, or switch to
`{"mode":"existing","number":"+1XXXXXXXXXX"}` to reuse a number already in the new Retell account.

**4. Validate (no side effects):**

```bash
npm run provision:agent -- --spec=./docs/clients/american-family/provision-spec.json --dry-run
```

**5. Provision for real:**

```bash
npm run provision:agent -- --spec=./docs/clients/american-family/provision-spec.json
```

Record the output: `retellAgentId`, `fromNumber`, `workspaceId`, `agentId`, `status` (will be
`draft` because CRM is deferred).

## After provisioning

**6. Add the live-transfer tool in Retell.** Open the new agent's Retell LLM and add a
**Transfer Call** tool named **`transfer_to_agent`** pointing at **+1 435-288-7434**, warm transfer,
using the whisper in `transfer-tool.json` / the prompt doc. The tool name MUST match the prompt.

**7. Verify prompt + voice in Retell.** Confirm the general prompt, begin message, and voice.
Audition the voice ("Riley" — a warm, natural American voice) and swap to your preferred one.

**8. Connect HighLevel** to the new "American Family Insurance" workspace in the app, and confirm
the standard **City** field is populated on your test contacts (that's what feeds `{{city}}`).

**9. Confirm the call window / timezone.** Defaults below are set for Arizona. Adjust if you dial
other states.

**10. Enroll + test.** Tag ONE real HighLevel contact with **`upsurge.amfam.transfer`**, make sure
the worker (`npm run worker`) is running inside the call window, and place a single test call.
Confirm: `{{city}}` reads correctly, no rate is ever quoted, a transfer happens ONLY after an
explicit yes, and the outcome writes back to HighLevel.

**11. Activate** via the `/admin` console or `npx tsx scripts/activate-agent.ts --workspace="American Family Insurance"`.

## Call window / cadence (in `provision-spec.json`)

| Setting | Value | Note |
| --- | --- | --- |
| Timezone | `America/Phoenix` | Arizona = MST year-round (no DST). Show Low / White Mountains. |
| Call days | **Mon–Sat** (`[1,2,3,4,5,6]`) | No Sunday calls. |
| Call window | **09:00–19:00** local | Well inside the TCPA 8am–9pm local limit; professional hours. |
| Max attempts | **6**, then terminal | Transfer offers don't need a long tail; tune to taste. |
| Cadence gaps | `[1,2,3,5,7,10]` | Days between attempts. |
| Max calls/day | 100 | Tune to your Retell plan + list size. |

> **Compliance reminders (outbound telemarketing):** call only within the recipient's local
> **8am–9pm** window (TCPA) — the 9–7 default is conservative; scrub against the **DNC** list and
> honor every remove-me request immediately (the agent captures it as `dnd`); the agent identifies
> itself and, if asked, discloses it's a virtual assistant; it never states or implies specific
> savings/rates; and if you dial states other than AZ, set the workspace timezone to match the
> list (or segment lists by timezone) so calls stay inside local hours.

## Optional enhancements (not required to go live)

- **Dedicated `transferred` outcome.** Today a completed transfer classifies as `appointment`
  (terminal success). If you want transfer-specific reporting, add a `transferred` alias to
  `RETELL_OUTCOME_CHOICES` + the classifier ALIAS map and treat it as terminal — small, isolated
  engine change.
- **Capture consent + callback fields.** Add Retell post-call analysis fields (e.g.
  `transfer_consent` yes/no, `callback_time`) if you want them written back as structured data
  alongside the note.
