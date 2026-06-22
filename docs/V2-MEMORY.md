# V2 — Real-time Agent Memory

The differentiator. Every other dialer treats each call as a cold start. UpSurge gives
each agent a **rolling, per-contact memory** that is read into the live Retell
conversation and rewritten after every call. The agent continues the relationship —
same objective, full recall of the last conversation — instead of re-introducing itself.

## The loop

```
                 ┌─────────────────────────────────────────────┐
                 │  agent_memory  (one row per agent × contact) │
                 │   summary · facts · objective_state ·        │
                 │   call_count · last_call_id                  │
                 └───────────────┬─────────────────────────────┘
            READ (before call)   │   WRITE (after call_analyzed)
                 ▼               │               ▲
   buildDynamicVariables()      │      updateMemoryAfterCall()
                 │               │               │
                 ▼               │               │
   Retell create-phone-call     │       summarizeForMemory()
   retell_llm_dynamic_variables │       (Haiku, deterministic fallback)
                 │               │               ▲
                 ▼               │               │
        live conversation  ──────┴──────►  transcript + outcome
```

### Read path — `buildDynamicVariables()` (`src/lib/engine/memory.ts`)

Just before a dial, the caller assembles the variables Retell exposes as `{{...}}` in
the agent prompt:

| Variable               | Source                                            |
| ---------------------- | ------------------------------------------------- |
| `contact_name`         | contact                                           |
| `objective`            | agent's standing objective                        |
| `attempt_number`       | this attempt                                      |
| `is_returning_contact` | `call_count > 0`                                  |
| `prior_call_count`     | memory                                            |
| `memory_summary`       | the compressed relationship note                  |
| `known_facts`          | structured JSON facts                             |

These ride along in `retell_llm_dynamic_variables` on the `create-phone-call` request,
so the agent opens the call already knowing where it left off.

### Write path — `updateMemoryAfterCall()`

Runs inside the `call_analyzed` webhook handler, after the outcome is classified. It
compresses `(prior memory + this call's transcript/summary + outcome + objective)` into
a fresh forward-looking note and upserts it (`onConflict: agent_id,contact_id`),
incrementing `call_count` and stamping `last_call_id`.

### Summarization — `summarizeForMemory()`

With `ANTHROPIC_API_KEY` set, it calls **claude-haiku-4-5** with a prompt that asks for a
4–6 sentence memory capturing rapport, stated preferences/objections, commitments made,
and the best next step toward the objective. Without a key it falls back to a
deterministic concatenation capped at 1500 chars, so the scaffold runs end-to-end with
no LLM. The cap keeps memory prompt-sized as call count grows.

## Data model

`agent_memory` (see `supabase/migrations/0001_initial_schema.sql`):

- `summary` — the natural-language note injected into the next call.
- `facts` (jsonb) — structured, durable facts (timezone preference, decision-maker,
  property details, etc.). Reserved for extraction logic; surfaced as `known_facts`.
- `objective_state` (jsonb) — progress toward the objective across calls
  (e.g. `{ stage: "nurturing", objections: ["price"] }`). Lets the agent adapt strategy,
  not just recall facts.
- `call_count`, `last_call_id` — bookkeeping.
- Unique on `(agent_id, contact_id)`.

## Roadmap toward "the AI brain"

The scaffold ships the summary loop end-to-end. The structured layers are designed in
but intentionally left as extension points:

1. **Fact extraction** — have the summarizer also emit a structured `facts` delta so
   `known_facts` becomes reliable typed data, not just prose.
2. **Objective-state machine** — model the objective as explicit stages and let the
   agent's strategy (tone, offer, urgency) shift with `objective_state`.
3. **Cross-contact learning** — aggregate which openings/obj* handling produce
   appointments per agent, and feed the winning patterns back into prompts.
4. **Outcome-weighted memory** — bias what the summarizer retains toward the moments
   that moved the contact closer to (or further from) the objective.

The seam for all of this is one function (`summarizeForMemory`) and two jsonb columns —
the read/write loop and storage do not change as the brain gets smarter.
