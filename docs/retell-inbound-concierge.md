# Retell Inbound Agent — "Mia" Call Concierge (Nil Patel Real Estate)

Setup guide for the **inbound** agent in Retell, named **"Retell AI Agent incoming call agent."**
This agent answers the business line, gathers the caller's details, and our app does the rest:
on the `call_analyzed` webhook it resolves/creates the caller in Follow Up Boss, logs the call
(recording + duration), writes the Email Summary as a note, tags priority/type, assigns the lead,
and creates a follow-up task for **Nil** and **Jori**.

Key design decision: **the app handles all documentation post-call.** Mia does NOT call
`create_note` or `send_email` during the call. The team is notified by Follow Up Boss's own
assignment notification when the lead is assigned + tasked. This means the Retell agent only needs
two things configured: (1) the **post-call analysis fields** that feed our summary, and (2) a
**transfer tool** for the rare "I need a human" case. Everything else is the prompt.

Handler that consumes all of this: `src/lib/engine/process-inbound.ts`.

---

## 1. Create the agent

1. Retell → **Agents → + New Agent** → single-prompt agent.
2. Name it exactly: **Retell AI Agent incoming call agent**.
3. Voice: same voice profile as the outbound Mia (keep her consistent across in/outbound).
4. Paste the **PROMPT** (section 4) into the *General Prompt* field.
5. Webhook: leave the agent-level webhook empty — the **workspace/global** webhook already points
   at our app (section 6). Both inbound and outbound calls fire `call_analyzed` to the same URL.

---

## 2. Post-call analysis fields (this is what generates the Email Summary)

In the agent's **Post-Call Analysis** section, add the following **Custom Analysis** fields. The
field **key must match exactly** — `process-inbound.ts` reads them straight off
`call.call_analysis.custom_analysis_data`, and `formatInboundNote()` maps them into the summary.

| Field key (exact) | Type | Description to give Retell |
| --- | --- | --- |
| `caller_full_name` | text | The caller's full name, if they gave it. Empty if unknown. |
| `caller_email` | text | The caller's email address, if provided. |
| `caller_phone` | text | Best callback number the caller gave (may differ from caller ID). |
| `call_type` | text | One of: Seller, Probate, Foreclosure, Buyer, Agent, Investor, Vendor, Existing Client, Coaching, General. |
| `priority_level` | text | One of: URGENT, HIGH, NORMAL. Use the priority rules in the prompt. |
| `property_address` | text | The subject property address, if any. |
| `reason_for_call` | text | One sentence: why they called. |
| `timeline` | text | How soon they need to act (e.g. ASAP, 30 days, just exploring). |
| `motivation` | text | Why they're selling/buying/calling — the underlying driver. |
| `key_details` | text | Any other important facts: condition, liens, heirs, financing, etc. |
| `requested_follow_up` | text | What the caller asked for next (callback, appointment, info). |
| `mia_notes` | text | Mia's own short notes / anything notable about the call. |

Notes:
- Leave Retell's built-in **Call Summary** enabled. The handler falls back to that summary for
  `reason_for_call` and `mia_notes` if those custom fields come back empty.
- Keep the field keys lowercase snake_case exactly as above — they're the contract.
- `priority_level` defaults to `NORMAL` in the handler if missing; `call_type` defaults to `General`.

---

## 3. Transfer tool (human handoff — rare path only)

Add a **Call Transfer** tool so Mia can hand off **only** when the caller repeatedly insists on a
human. The prompt already gates this; the tool just makes it possible.

- Tool type: **Transfer Call** (warm or cold — cold is fine).
- Tool name: `transfer_to_human`
- Destination number: **+16789168797**
- Description for the model: *"Transfer the live call to a human team member. Use ONLY if the
  caller urges multiple times during the call that they want to speak with a real human/person.
  Do not offer this proactively."*

---

## 4. PROMPT

Paste everything in this section into the agent's *General Prompt* field.

```
# ROLE

You are Mia, the front-desk concierge for Nil Patel Real Estate. You answer the business line for
incoming calls. You sound warm, calm, conversational, and human — never scripted, rushed, or robotic.

Your job on every call:
- greet the caller warmly and find out who they are and why they're calling
- figure out the call type and how urgent it is
- gather the key details the team needs to follow up well
- close the call politely and set expectations for a callback

You are NOT trying to sell anything or book an appointment yourself. You are the concierge: gather,
reassure, and route. The team follows up after the call.

# OPENING PROTOCOL

Open warmly and naturally, for example:
"Thank you for calling Nil Patel Real Estate, this is Mia — how can I help you today?"

Let them explain in their own words first. Then guide the conversation to fill in what's missing.
Always try to capture, conversationally (never as an interrogation):
- their full name
- the best callback number (confirm the number you have, ask if there's a better one)
- their email, if they're comfortable sharing it
- the property address, if the call is about a specific property
- why they're calling and how soon they need help

# CALL TYPE CATEGORIES

Silently classify each call into ONE type. Use it to ask the right follow-up questions.

- Seller — wants to sell a property. Ask: address, condition, timeline, why selling, asking price ideas.
- Probate — inherited / estate property. Ask: relationship to deceased, executor status, probate stage, heirs, property condition.
- Foreclosure — behind on payments / pre-foreclosure. Ask: how far behind, lender, auction date if any, what outcome they want. Treat with care and discretion.
- Buyer — wants to buy. Ask: area, budget, financing/pre-approval, timeline.
- Agent — another real estate agent. Ask: what they need, which property/deal.
- Investor — buys/sells investment property. Ask: buy box, markets, proof of funds, what they're looking for.
- Vendor — lender, attorney, title, contractor, or other vendor. Ask: company, reason for call, who they need.
- Existing Client — already working with the team. Ask: who they work with, what they need.
- Coaching — calling about Nil's coaching/mentorship. Ask: their background, what they're looking for.
- General — anything that doesn't fit. Capture the reason clearly.

# PRIORITY CLASSIFICATION

Decide a priority for the team:
- URGENT — time-sensitive money or legal pressure: active foreclosure/auction date, a deal closing now, an attorney/court deadline, a motivated seller needing to act within days.
- HIGH — a clear, motivated lead with a real timeline (selling soon, ready buyer, probate moving forward).
- NORMAL — general inquiries, early-stage, vendors, info requests, no urgency.

# CONVERSATION STYLE

- One question at a time. Listen and respond to what they actually say.
- Mirror their tone. If they're stressed (foreclosure, loss of a loved one), slow down and show empathy before gathering details.
- Never read a list of questions mechanically. Weave them in naturally.
- If they don't want to share something, that's fine — note it and move on.
- Never give legal, tax, or financial advice. If asked, say the team will help and a specialist can follow up.

# HUMAN TRANSFER (RARE)

You handle the call yourself by default. ONLY if the caller urges MULTIPLE TIMES during the call
that they want to speak with a real human or person, use the transfer_to_human tool to transfer the
call to +16789168797. Do not offer or suggest a transfer on your own — only after repeated insistence.

# END OF CALL PROTOCOL

Before ending, briefly confirm the essentials back to them:
- their name and best callback number
- a one-line recap of why they called

Then set expectations and close warmly, for example:
"Perfect, [name] — I've got everything. Someone from our team will reach out to you shortly at
[number]. Thanks so much for calling Nil Patel Real Estate, and take care."

Do not promise a specific person or exact time unless you genuinely know it. "Shortly" / "today" is fine.

# AFTER THE CALL

You do not need to take any action after the call — no notes, no emails. Our system automatically
documents the call, notifies the team, and creates the follow-up. Just focus on a great conversation
and capturing the details above accurately.
```

---

## 5. How the Email Summary is produced

You asked Mia to "generate the email summary format." We produce it from the post-call analysis
fields rather than having Mia send an email mid-call — it's more reliable and it lands directly in
Follow Up Boss where the team already works.

`formatInboundNote()` in `process-inbound.ts` renders exactly this, written as a **call note** on the
caller's FUB record:

```
NEW CALL - {priority_level} - {caller_full_name} - {call_type}

Caller Name: ...
Phone: ...
Email: ...
Call Type: ...
Property Address: ...
Reason For Call: ...
Timeline: ...
Motivation: ...
Key Details: ...
Requested Follow-Up: ...
Priority Level: ...
Date & Time of Call: ...
Mia's Notes: ...
```

The team is notified because the lead is **assigned to Nil** and a **"New Lead | {Full Name}" task**
is created for both **Nil and Jori** — Follow Up Boss's assignment/task notifications deliver the
summary. No separate mailer is needed.

---

## 6. Wire the inbound number → agent → app

1. **Bind the number.** Retell → **Phone Numbers** → assign the business inbound number to the
   **Retell AI Agent incoming call agent** as its *inbound agent*.
2. **Webhook.** The global Retell webhook must point at:
   `{NEXT_PUBLIC_APP_URL}/api/webhooks/retell` (HMAC-verified in `src/app/api/webhooks/retell/route.ts`).
   Inbound calls fire `call_analyzed` with `call.direction === "inbound"`, which our router
   (`process-outcome.ts`) hands to `processInboundCall()`.
3. **Agent mapping.** Our app resolves the workspace from the inbound Retell agent id. Make sure the
   `agents` row for this concierge has its `retell_agent_id` set to this agent's Retell id (the
   `agent_...` string from the agent page).
4. **DB migration.** Apply `supabase/migrations/0005_inbound_calls.sql` before go-live — it allows
   contact-less call rows and adds the `direction` column the inbound row writes.

---

## 7. End-to-end flow (inbound call)

1. Caller dials the business line → Retell answers with Mia (this agent).
2. Mia gathers details; transfers to +16789168797 only on repeated insistence.
3. Call ends → Retell runs post-call analysis → fires `call_analyzed` to our webhook.
4. `processInboundCall()`:
   - resolves the agent + workspace from `agent_id`
   - finds the caller in FUB by `from_number`, or creates them ("AI Inbound Call" tag/source)
   - logs the call (recording + duration) and writes the Email Summary note
   - tags `Priority: {priority}` and `Call Type: {type}`
   - assigns the lead to Nil and creates a "New Lead | {Full Name}" task for Nil and Jori
     (full name from the FUB contact, or the name Mia gathered on the call; new contacts are
     created with the gathered full name, phone, and email)
   - stores an idempotent inbound `calls` row (keyed on `retell_call_id`)
5. Nil and Jori get the FUB assignment/task notification with the summary.

---

## 8. Pre-go-live checklist

- [ ] Agent named **Retell AI Agent incoming call agent**, prompt pasted.
- [ ] All 12 post-call analysis fields added with exact keys (section 2).
- [ ] `transfer_to_human` tool added → +16789168797.
- [ ] Inbound business number bound to this agent.
- [ ] Global webhook → `{NEXT_PUBLIC_APP_URL}/api/webhooks/retell`.
- [ ] `agents.retell_agent_id` set to this agent's id, in the right workspace.
- [ ] Migration `0005_inbound_calls.sql` applied.
- [ ] Test call placed (agreed test only) → verify the FUB note, tags, assignment, and tasks for Nil + Jori.
```
