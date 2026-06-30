# Nil Patel Realty — "Ava" Circle Prospecting Agent (runbook)

A **new outbound agent** added to the **existing** Nil Patel Realty workspace. Ava calls
homeowners in a farmed neighborhood to find buyers, surface referrals, uncover each
homeowner's real-estate goals, and **book a 15-minute phone consultation**. She inherits
the workspace's **already-connected Follow Up Boss** integration and books live via
**Cal.com**.

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
| **Enroll tag** | `nilpatelcircleprospecting` — tag a contact with this in FUB to enroll them |
| Booking | Live Cal.com (`check_availability_cal` / `book_appointment_cal`), wired after provisioning |
| Call days | **Tue–Sat** (`call_window_days: [2,3,4,5,6]`) |
| Call window | **1:00pm–7:00pm ET** (workspace timezone America/New_York) |
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

If a computed next-call date lands on a Sunday or Monday (non-call days), the poller simply
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

**8. Enroll contacts in Follow Up Boss** — apply the tag **`nilpatelcircleprospecting`** to any
FUB contact you want Ava to call. The engine inherits the workspace's existing FUB connection,
syncs tagged contacts, and starts the cadence. (No new FUB setup needed.)

**9. Test** — tag one real contact, confirm a single dial happens inside the Tue–Sat 1–7pm ET
window and that the outcome writes back to FUB.

**10. Activate** — once verified, flip the agent to active via the `/admin` console (or set
`activate: true` in the spec and re-run). The scheduler then polls daily and dials enrolled
contacts on the configured cadence.

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
