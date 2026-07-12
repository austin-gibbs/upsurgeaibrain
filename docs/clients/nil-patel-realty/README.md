# Nil Patel Realty — "Ava" Circle Prospecting Agent (runbook)

A **new outbound agent** added to the **existing** Nil Patel Realty workspace. Ava calls
homeowners in a farmed neighborhood to find buyers, surface referrals, uncover each
homeowner's real-estate goals, and **book a 15-minute phone consultation**. She inherits
the workspace's **already-connected Follow Up Boss** integration and books live via
**Cal.com**.

## Status: ✅ PROVISIONED (2026-06-30)

Created live via the `/admin` console (`POST /api/console/provision`) into the Retell account
from `.env.local` and the existing Nil Patel Realty workspace. Landed as **draft** (no calls).

| Resource | ID |
| --- | --- |
| Retell LLM | `llm_890e5bf05337343fac7239956d10` |
| Retell agent | `agent_b50407cecd1888fb6d9b15bda3` |
| Outbound number | **+1 470‑333‑7394** |
| App agent row | `fafbdf14-5a00-49e2-90ac-bb2064aa5d37` |
| Workspace | `28803e2d-a78d-4377-a718-824c58116151` (Nil Patel Realty, FUB) |
| Enroll tag | `upsurge.circleprospecting.ai` |
| Status | `active` |

**Cal.com booking: ✅ wired (2026-06-30).** Copied the Probate agent's exact `check_availability_cal`
+ `book_appointment_cal` tools onto Ava's LLM (`llm_890e5bf05337343fac7239956d10`) — same Cal.com
event `5936698`, same keys, America/New_York. (They share the Probate calendar/event; create a
separate 15-min event later if you want Ava's consults booked on their own calendar.)

**Prompt: ✅ updated (2026-06-30) — dual-direction + full memory fields.** Ava's live LLM prompt
now (a) documents and uses the exact app-injected memory the probate agent gets — the 7 dynamic
variables + the real `FACT_KEYS` for `{{known_facts}}` (no invented keys), and (b) branches on
`{{call_direction}}`: the existing script is the **OUTBOUND** branch; a full **INBOUND** branch was
added for callbacks. Engine change: `call_direction:"outbound"` is now injected by
`buildDynamicVariables()` (+ the test-call path) — takes effect on the next app deploy. Until then,
the prompt safely defaults to outbound and self-corrects to inbound from the caller's words.

> Inbound options: (a) keep using the workspace's dedicated **Incoming Call Agent** for the main
> line, or (b) bind Ava as the inbound agent on **+1 470‑333‑7394** so callbacks hit her — in which
> case have the inbound path pass `call_direction:"inbound"`. A single Retell agent has one begin
> message (outbound-oriented), so for a flawless inbound greeting prefer the dedicated inbound agent.

**Go-live:** Tag FUB contacts with **`upsurge.circleprospecting.ai`** only. Older doc tags
(`upsurge.circle.ai`, `nilpatelcircleprospecting`) are obsolete and will not enroll contacts.
The provisioning steps below are kept for reference / re-runs.

## Files

- `circle-prospecting-agent-prompt.md` — canonical Retell `general_prompt` + begin message for "Ava".
- `provision-spec.json` — the provisioning spec (run with `scripts/provision-agent.ts`). The prompt + begin message are already embedded; keep this file and the prompt doc in sync.

## What's configured

| Setting | Value |
| --- | --- |
| Agent name | `Nil Patel Realty \| Circle Prospecting AI Agent` ("Ava") |
| Direction | Outbound |
| Voice | `11labs-Grace` (warm, natural female; swap in Retell — alts: `11labs-Hailey`, `11labs-Sloane`) |
| Objective | Find buyers, surface referrals, uncover goals, book a 15-min consult |
| CRM | Inherits the workspace's **existing Follow Up Boss** connection |
| **Enroll tag** | `upsurge.circleprospecting.ai` — tag a contact with this exact string in FUB to enroll them |
| Booking | Live Cal.com (`check_availability_cal` / `book_appointment_cal`), wired after provisioning |
| Call days | **Tue–Sun** (`call_window_days: [2,3,4,5,6,7]`) |
| Call window | **3:00pm–7:00pm ET** (workspace timezone America/New_York) |
| Max attempts | **77**, then terminal |
| Cadence | Attempts **1–20 weekly**, **21–50 every 21 days**, **51–77 every 38 days** |

### Cadence detail

`cadence_day_gaps` is indexed by attempt number; each value is the days to wait before the
next attempt. The array is `[7×20, 21×30, 38×27]` (77 entries), which reproduces the schedule
exactly (verified programmatically):

- Attempts 1→20: 7-day spacing (once per week)
- Attempts 20→50: 21-day spacing
- Attempts 50→77: 38-day spacing
- After attempt 77: contact is terminal (no more calls)

If a computed next-call date lands on a Monday (non-call day for this agent), the poller simply
rolls the contact to the next allowed day (Tuesday) — spacing is a floor, not an exact date.

## Provisioning steps (run locally in the UpSurge repo — needs `.env.local` + network)

> The Cowork sandbox can't reach Retell/Supabase, so run these from your machine (Cursor/terminal)
> where `.env.local` and a same-platform `node_modules` exist.

**1. Get the Nil Patel Realty workspace UUID** and paste it into `provision-spec.json`
(`workspace.id`). In the Supabase SQL editor:

```sql
select id, name, crm_provider, enroll_tag
from workspaces
where name ilike '%nil patel%';
```

**2. Confirm the Retell API key.** `provision-spec.json` reuses the agency key
(`key_6656f379…`). Confirm the existing Nil Patel agents (e.g. "Mia") live in **that same
Retell account**. If Nil Patel uses a different Retell account, replace `retell.apiKey` with
its key.

**3. Set the phone area code.** `retell.phone.areaCode` defaults to `470`. Change it to the
local area code of the farm market so caller ID looks local — or switch to
`{"mode":"existing","number":"+1XXXXXXXXXX"}` to reuse an existing Nil Patel number.

**4. Validate (no side effects):**

```bash
npm run provision:agent -- --spec=./docs/clients/nil-patel-realty/provision-spec.json --dry-run
```

(The dry-run will flag the workspace UUID if it's still the placeholder — that's the check working.)

**5. Provision for real:**

```bash
npm run provision:agent -- --spec=./docs/clients/nil-patel-realty/provision-spec.json
```

Record the output: `retellAgentId`, `fromNumber`, `agentId`, `workspaceId`, `status`
(will be `draft` because `activate:false`).

## After provisioning

**6. Verify in Retell** — open the new agent, confirm the prompt, begin message, and voice.
Audition `11labs-Grace` and swap to the current top-trending voice if you prefer.

**7. Wire Cal.com booking** — add two custom functions to the agent's Retell LLM, pointing at
the Nil Patel Realty Cal.com **15-minute consultation** event:

- `check_availability_cal` — returns open slots
- `book_appointment_cal` — books the chosen slot + sends the invite

(Mirror exactly how the "Mia" agent's Cal.com functions are configured. Provide the Cal.com
event link / API key in the function config.)

**8. Enroll contacts in Follow Up Boss** — apply the tag **`upsurge.circleprospecting.ai`** to any
FUB contact you want Ava to call. The engine inherits the workspace's existing FUB connection,
syncs tagged contacts, and starts the cadence. (No new FUB setup needed.)

**9. Test** — tag one real contact, confirm a single dial happens inside the Tue–Sun 3–7pm ET
window and that the outcome writes back to FUB.

**10. Activate** — once verified, flip the agent to active via the `/admin` console (or set
`activate: true` in the spec and re-run). The scheduler then polls every 30s during the call
window and dials enrolled contacts on the configured cadence.

**Health check:** `npx tsx scripts/poll-doctor.ts 28803e2d-a78d-4377-a718-824c58116151`

## Notes

- **Memory:** Ava uses the same V2 memory variables as Mia (`is_returning_contact`,
  `memory_summary`, `known_facts`, etc.). Returning-call "they felt remembered" magic needs
  `ANTHROPIC_API_KEY` set; without it those keys stay empty and the prompt's "if present"
  guards no-op (safe).
- **Area is generic** ("your neighborhood / your area") so one agent works across any farm
  list. To name a specific neighborhood, edit the OPENING / PITCH sections of the prompt and
  re-embed into `provision-spec.json`.
- **Outcomes** map to the UpSurge default classifier: a booked consult = `appointment`,
  interested-but-no-time = `interested_no_appointment`, removal = `dnd`.
