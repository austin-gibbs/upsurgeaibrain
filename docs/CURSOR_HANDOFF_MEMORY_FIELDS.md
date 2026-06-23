# Cursor Handoff — Add 3 Durable Memory Fields (next_step, timezone, consent_status)

_Generated 2026-06-22. Scope: `src/lib/engine/memory.ts` only. No DB migration,
no Retell change, no `buildDynamicVariables` change required (see "Why no wiring
change" below)._

---

## Paste this into Cursor to get oriented

> I'm continuing work on UpSurge. Each AI voice agent keeps a per-(agent×contact)
> rolling memory so it can continue a relationship across calls. Storage is the
> `agent_memory` table: a rolling lossy `summary` (text) and a durable
> merge-forward `facts` (jsonb). The code is `src/lib/engine/memory.ts`:
> READ path `buildDynamicVariables`, WRITE path `updateMemoryAfterCall`, plus
> `summarizeForMemory` and `extractFacts` / `llmExtractFacts`.
>
> The fact schema (`FACT_KEYS` = `PERSONAL_FACT_KEYS` + `BUSINESS_FACT_KEYS`)
> currently captures rapport and probate/business details but is missing three
> high-value durable signals for an outbound voice nurture. Add exactly these
> three keys to `BUSINESS_FACT_KEYS`, and teach the extraction prompt when to
> fill them: `next_step`, `timezone`, `consent_status`. Do NOT add any other
> keys. Don't touch the DB (facts is jsonb — no migration). Don't place real
> outbound calls. Keep `.env.local` gitignored.

---

## Why these three (and not more)

Each key the model must populate dilutes its attention and grows the prompt, so
keep the addition tight. These three each make the next call materially better:

1. **`next_step`** — the single agreed next action and rough timing
   (e.g. `"call back Tue AM"`, `"walkthrough booked Thu"`). Today this only lives
   in the lossy prose `summary`, so it degrades as `summary` is re-compressed each
   call. Promoting it to a durable fact means the returning-call opening can lead
   with the exact commitment instead of a generic "just following up."

2. **`timezone`** — the contact's own timezone (e.g. `"America/New_York"`). The
   call-window / cadence logic is timezone-driven, and `best_call_window` already
   exists but carries no zone. Capturing the zone makes "early morning or
   afternoon" unambiguous and protects against off-hours dials.

3. **`consent_status`** — compliance signal for an outbound voice product
   (e.g. `"ok to call"`, `"callback only"`, `"do not call"`). You already have a
   `dnd` terminal outcome; a durable per-contact consent fact lets the agent (and
   any later audit) see the standing instruction, not just the last outcome.

> Optional, NOT in scope unless you want it: `preferred_name` (nickname / how they
> like to be addressed) is a cheap rapport win. Left out to keep this change to the
> three highest-value fields — add later if desired.

---

## Exact changes in `src/lib/engine/memory.ts`

### 1. Extend `BUSINESS_FACT_KEYS`

Add the three keys to the existing array (order doesn't matter; grouped logically
with the other logistics fields). `FACT_KEYS` already composes from this array, so
nothing else in the schema plumbing changes.

```ts
export const BUSINESS_FACT_KEYS = [
  "probate_status",
  "executor_status",
  "motivation",
  "timeline",
  "property_condition",
  "repairs_needed",
  "occupancy_status",
  "realtor_involved",
  "appointment_status",
  "email",
  "best_phone",
  "best_call_window",
  "emotional_tone",
  // --- NEW durable signals ---
  "next_step",      // the agreed next action + rough timing
  "timezone",       // contact's timezone, e.g. "America/New_York"
  "consent_status", // "ok to call" | "callback only" | "do not call"
] as const;
```

### 2. Teach the extraction prompt the new keys

In `llmExtractFacts()`, the business-details bullet enumerates the fields the model
should fill. Extend it so Haiku knows when to populate the three new keys. Replace
the existing business bullet (the line beginning
`"2. BUSINESS / QUALIFICATION details ..."`) with:

```ts
"2. BUSINESS / QUALIFICATION details relevant to the agent's objective (e.g. for a probate/real-estate call: probate_status, executor_status, motivation, timeline, property_condition, repairs_needed, occupancy_status, realtor_involved, appointment_status), plus contact logistics: email, best_phone, best_call_window, emotional_tone, and:",
"   - next_step: the single agreed next action and rough timing the contact accepted (e.g. 'call back Tue morning', 'walkthrough booked Thu 2pm', 'send info by email'). Capture what was actually agreed, not a hope.",
"   - timezone: the contact's timezone if it can be inferred or stated (IANA form like 'America/New_York', or a plain region like 'Eastern'). Only fill when there's real evidence.",
"   - consent_status: the standing call permission the contact expressed — 'ok to call', 'callback only', or 'do not call'. Only set 'do not call' on an explicit removal/stop request.",
```

No change to the "Rules" block is needed: it already says
`` `- Allowed keys ONLY: ${FACT_KEYS.join(", ")}.` ``, and `FACT_KEYS` now includes
the three new keys automatically.

### 3. (Sanity only) `mergeFacts` already handles them

`mergeFacts` iterates `FACT_KEYS` and skips empty/`"unknown"`/`"n/a"` readings, so
the new keys merge-forward and are protected from erasure with zero extra code.
Nothing to change — just confirm.

---

## Why no wiring change (important)

`buildDynamicVariables()` serializes the **entire** `facts` object to Retell as
`{{known_facts}}`:

```ts
known_facts: memory ? JSON.stringify(memory.facts ?? {}) : "{}",
```

So once `extractFacts` starts writing `next_step` / `timezone` / `consent_status`,
they appear inside `{{known_facts}}` automatically. The Retell prompt
(`docs/retell-mia-prompt-v2.md`) is already written to read these keys out of
`{{known_facts}}` — no new dynamic variable is required. Do **not** add dedicated
`{{next_step}}` etc. variables.

---

## Acceptance test (no real outbound call)

1. Ensure `ANTHROPIC_API_KEY` is set (without it `extractFacts` short-circuits and
   no facts ever populate — that's the known karate-forgetting cause).
2. `npm run typecheck` — must pass (the `as const` arrays stay literal-typed).
3. Unit-style check: call `extractFacts` (or exercise `updateMemoryAfterCall`) with
   a transcript like _"Yeah, call me back Tuesday morning, I'm on the east coast"_
   and assert the merged facts contain `next_step` ≈ "call back Tuesday morning"
   and `timezone` ≈ "Eastern"/"America/New_York".
4. Feed a follow-up call with no mention of timing and assert `next_step` /
   `timezone` are **retained** (merge-forward, not wiped).
5. Feed _"please take me off your list"_ and assert `consent_status` = "do not call".

---

## Guardrails (from CLAUDE.md — do not violate)

- Don't place real outbound calls beyond agreed testing.
- Don't commit `.env.local`; it holds real secrets and stays gitignored.
- Behavior parity with the live n8n system remains the cutover bar — this change is
  additive and must not alter existing fact behavior.
