# Nil Patel Realty — "Sophie" New Seller Lead (Speed-to-Lead) Agent (runbook)

A **new outbound agent** added to the **existing** Nil Patel Realty workspace. Sophie calls
**brand-new seller leads within ~30–60 seconds** of them being tagged in Follow Up Boss,
verifies the person + their home, gathers a few high-level details (interest, ballpark numbers,
timeframe, ideal timing), and **books a 15-minute phone consultation with an expert agent** via
the existing Nil Patel Cal.com event. Inherits the workspace's already-connected Follow Up Boss.

## Status: ✅ PROVISIONED — draft (2026-07-13)

Created live via the `/admin` console (`POST /api/console/provision`) into the Nil Patel Realty
Retell account and the existing Nil Patel Realty workspace. Landed as **draft** (no calls yet).

| Resource | ID |
| --- | --- |
| Retell agent | `agent_77f22af426d1748d8f356956b6` |
| Retell LLM | `llm_c434710af94f505e074a9080bde8` |
| App agent row | `cb61b205-800c-4a74-ac7e-a6ca600e1a48` |
| Workspace | `28803e2d-a78d-4377-a718-824c58116151` (Nil Patel Realty, FUB) |
| Outbound number | **+1 470-410-4507** (existing, reused) |
| Enroll / trigger tag | **`upsurge.ppl.ai`** |
| Voice | `11labs-Grace` |
| Status | `draft` (activationBlockedReason: null — FUB connected, ready to activate) |

**Cal.com booking: ✅ wired (2026-07-13).** Copied Ava's `check_availability_cal` +
`book_appointment_cal` tools onto Sophie's LLM — same Cal.com **event `5936698`**, America/New_York
(shares the existing Nil Patel calendar). Create a separate event later if you want seller consults
booked on their own calendar.

## What's configured

| Setting | Value |
| --- | --- |
| Agent name | `Nil Patel Realty \| New Seller Lead AI Agent` ("Sophie") |
| Direction | Outbound (speed-to-lead) |
| Objective | Verify the lead + home, learn interest/ballpark/timeframe/ideal timing, book an expert consult |
| CRM | Inherits the workspace's existing **Follow Up Boss** connection |
| **Enroll tag** | `upsurge.ppl.ai` — apply to a new seller lead in FUB to fire the call |
| Booking | Live Cal.com (`check_availability_cal` / `book_appointment_cal`, event `5936698`) |
| Call window | **8:00am–8:00pm ET**, all 7 days (`call_window_days [1..7]`) |
| Speed | Poller runs every 30s across the window → a freshly-tagged lead is dialed within ~30–60s |
| Cadence | `cadence_day_gaps [0,1,1,1,1,7,7,7,7]`, `max_attempts_per_contact 9` — 1×/day for the first 5 days (attempts 1–5, days 0–4), then 1×/week for 4 weeks (attempts 6–9), then terminal. Updated 2026-07-13. |
| Daily cap | `max_calls_per_day 200`, `drip_seconds 45` |

### Cadence detail

`cadence_day_gaps` is indexed by attempt: `gaps[0]=0` fires attempt 1 **at enrollment** (day 0),
then `+1d, +1d, +1d, +1d` (attempts 2–5 on days 1–4 = **1×/day for the first 5 days**), then
`+7d, +7d, +7d, +7d` (attempts 6–9 = **1×/week for 4 weeks**). 9 attempts total, then terminal.
The engine dials each contact **at most once per day** — same-day rapid retries are not expressible
via config. If a computed date lands outside the call window/day it rolls to the next allowed slot.

## The address requirement (IMPORTANT — needs a deploy)

The call script verifies the lead by **first name + property address**. First name is always
injected (`{{contact_name}}`). The **address** is injected as `{{property_address}}` from the FUB
contact, but that required a small engine change:

- **Code change (done, uncommitted in this repo):** `getContactFieldValues` added to
  `FollowUpBossAdapter` (`src/lib/crm/followupboss.ts`). It pulls the FUB `addresses[]` and exposes
  `property_address`, `first_name`, `last_name`, `city`, `state`, `postal_code`, `street` as Retell
  dynamic variables. `src/lib/engine/caller.ts` already merges `getContactFieldValues` over the base
  variables, so no caller change was needed. Typecheck clean in-sandbox.
- **To go live:** commit + push + deploy via Cursor. Until then, `{{property_address}}` is empty and
  the prompt **safely verifies by first name only** (the prompt is written to skip the address line
  when the variable is blank, and never leak a blank field). Once deployed, address verification
  turns on automatically with no prompt change.

## Go-live checklist

1. **Verify in Retell** — open agent `agent_77f22af426d1748d8f356956b6`, confirm the prompt, begin
   message ("Hi, is this {{contact_name}}?"), and voice. Optionally optimize `11labs-Grace` for
   human-likeness (backchanneling on, interruption sensitivity ~0.9, voice temperature ~0.9).
2. **(Recommended) Deploy the FUB address change** so `{{property_address}}` resolves.
3. **Test one call** — tag a test contact (with an address on file) `upsurge.ppl.ai` in FUB inside
   the 8am–8pm ET window; confirm a single dial happens within ~a minute, the home is verified, and
   the outcome writes back to FUB.
4. **Activate** — flip to active via `/admin` ("Manage an existing workspace" → Activate), or run
   `npx tsx scripts/activate-agent.ts --workspace="Nil Patel Realty"`.
5. **Wire the FUB automation** — set the FUB workflow that applies **`upsurge.ppl.ai`** to a new
   seller lead the moment it's created (this is the trigger that starts the speed-to-lead call).

**Health check:** `npx tsx scripts/poll-doctor.ts 28803e2d-a78d-4377-a718-824c58116151`

## Files

- `new-seller-lead-agent-prompt.md` — canonical Retell `general_prompt` + begin message ("Sophie").
- `provision-spec-new-seller-lead.json` — provisioning spec (Retell key intentionally a placeholder).

## Outcomes

Maps to the UpSurge default classifier: booked consult = `appointment`, interested-but-no-time =
`interested_no_appointment`, removal = `dnd`.
