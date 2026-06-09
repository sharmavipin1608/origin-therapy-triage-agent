# Cedar Kids Therapy — Referral Inbox Triage Agent

An AI agent that processes a pediatric therapy practice's weekend inbox and produces a sorted, human-reviewable action plan. Each item is classified, triaged, routed to the appropriate tools, and returned as a structured `ItemOutput` with full audit trace.

---

## Design Documentation

The `docs/` directory contains the full design and decision record for this submission:

- `docs/decisions/decisions.md` — every architectural decision with rationale and tradeoffs (D001–D029)
- `docs/phase-1-design.md`, `docs/phase-2-design.md` — phased implementation plans
- `docs/observability-design.md` — design for token tracking (not implemented; see "What I Chose Not to Build")
- `docs/proofs/phase-2/` — output snapshot, tool trace, and verification report from the final triage run

---

## How to Run

**Prerequisites:** Node.js LTS (v20+), an Anthropic API key.

```bash
# 1. Install dependencies
npm install

# 2. Set your API key
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# 3. Run the triage agent (defaults to data/inbox.json → output.json)
npm run triage

# or with explicit paths:
npm run triage -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl

# 4. Validate the output
npm run validate

# or with explicit paths:
npm run validate -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
```

Expected end-to-end runtime: 30–90 seconds (8 items processed in parallel, each making 2–5 LLM calls).

To run the unit test suite (47 tests, no API calls required):

```bash
npm test
```

---

## Stack and Runtime

| Component | Choice |
|---|---|
| Language | TypeScript 5, strict mode |
| Runtime | Node.js LTS (v20+), ESM (`"type": "module"`) |
| LLM provider | Anthropic SDK (`@anthropic-ai/sdk`) |
| Model | `claude-sonnet-4-6` |
| Prompt caching | `cache_control: { type: "ephemeral" }` on system prompt — first call caches, subsequent loop iterations reuse at ~90% reduced input token cost |
| Module resolution | NodeNext (explicit `.js` extensions on local imports) |
| Test runner | Node built-in `node:test` (zero added test dependencies) |
| Env loading | `dotenv` (`import 'dotenv/config'`) |
| ID generation | `ulid` (provided by starter) |

No framework, no build step. `tsx` runs TypeScript directly via `npm run triage`.

---

## Architecture

The agent is a parallel agentic loop. Each inbox item is processed independently and concurrently.

```
src/index.ts
  │
  ├─ parseCliArgs()         reads --input/--output/--trace flags
  ├─ configureTrace()       opens the JSONL audit file
  ├─ runAgent(inbox)
  │     │
  │     └─ Promise.all → [processItem(item), ...]   ← 8 parallel loops
  │
  └─ buildBatchOutput()     assembles summary counts, writes output.json

processItem(item, client)
  │
  ├─ withItemContext(item.id, async () => {
  │
  ├─ Build messages[]       system prompt (cached) + user message (raw item JSON)
  │
  ├─ client.messages.create  first LLM call
  │
  ├─ Agentic loop (max 15 iterations):
  │     while stop_reason === "tool_use"
  │       ├─ Filter ToolUseBlocks from response.content
  │       ├─ dispatchTool(name, args)  → executes tool fn from tools.ts
  │       ├─ Collect task_ids from create_task results
  │       ├─ Append ToolResultBlockParams to messages[]
  │       └─ client.messages.create  next LLM call
  │
  ├─ validateLlmOutput()    two-layer parse: brace-depth JSON extraction + field validation with safe defaults
  ├─ applySafetyGuard()     code-level P0/safeguarding consistency enforcement
  ├─ getToolCallsForItem()  pulls exact trace entries for tools_called[]
  │
  └─ Return ItemOutput
```

**Key design properties:**

**Claude drives tool selection.** The system prompt provides routing rules (urgency decision tree, insurance gate, language access, etc.); the LLM decides which tools to call and in what order. There is no hardcoded dispatch table — adding a new item type means updating the prompt, not the code.

**Audit trace is authoritative.** `tools.ts` records every tool call with a ULID `call_id`, `item_id`, args, result summary, and timestamp to `.trace/tool-calls.jsonl`. The validator cross-checks this trace against `tools_called[]` in the output; the agent passes `getToolCallsForItem()` through unchanged.

**Two-layer output validation.** `validateLlmOutput()` first extracts the JSON object from Claude's response using brace-depth tracking (handles non-JSON prose before or after the object), then validates each field against expected types and enums. Invalid values fall back to safe defaults; failures are noted in `decision_rationale`.

**Post-LLM safety guard.** `applySafetyGuard()` runs after output validation. Any single P0 signal — `urgency === "P0"`, `classification === "safeguarding"`, or `escalation.severity === "P0"` — forces all three to agree. This is code-level enforcement that cannot be overridden by prompt drift. Overrides are logged in `decision_rationale`.

**Graceful degradation.** If an item's agentic loop throws (API error, iteration cap exceeded, malformed response), the `catch` block returns a valid `ItemOutput` with `classification: "other"` and the error reason in `decision_rationale`. The batch never fails catastrophically on a single item.

**Source layout:**

| File | Responsibility |
|---|---|
| `src/agent.ts` | Agentic loop — `dispatchTool`, `processItem`, `runAgent` |
| `src/prompts.ts` | `SYSTEM_PROMPT` constant |
| `src/tools-schema.ts` | Anthropic tool definitions (8 tools with enum constraints) |
| `src/llm-output-validator.ts` | `validateLlmOutput`, `applySafetyGuard`, validation helpers |
| `src/agent.test.ts` | 47 unit tests (validation layer, safety guard, no API calls) |

---

## Failure Modes and Production Eval

### Known failure modes

**1. Safeguarding misclassification (highest severity)**
A harm disclosure buried in a routine-sounding message (e.g. "getting rough with him" inside an SLP intake voicemail) can be misread as a new referral if the model focuses on the explicit ask ("speech therapy openings") rather than the embedded signal. Mitigation: the safeguarding rule appears first in the urgency decision tree with explicit trigger phrase examples, and `applySafetyGuard()` enforces consistency at the code level. Production mitigation would require a dedicated pre-screening pass with a focused classifier before the main agentic loop.

**2. Over-escalation**
The model may call `escalate` on a same-day cancellation (item_8) because the subject line says "URGENT!!!" — but P1 is operational, not clinical, and `escalate` routes to `clinical_lead`, polluting the escalation log. Mitigation: explicit prompt rule distinguishing P1 operational from P0 clinical with `escalate` prohibited on P1 items.

**3. Language mismatch in slot search**
For Spanish-speaking families, calling `find_slots` without `language="es"` returns English-only providers. This is a silent failure — the tool call succeeds and the output looks valid, but the held slot is for a provider who cannot serve the family. Mitigation: the prompt makes `language="es"` mandatory; production mitigation would enforce this at the tool-dispatch layer.

**4. Hallucinated slot IDs in `hold_slot`**
If the model calls `hold_slot` with a fabricated `slot_id` rather than one returned by a preceding `find_slots`, the hold is meaningless. Mitigation: the tool description and the hold_slot checklist in the prompt require the slot_id to come from the current loop's `find_slots` result.

**5. JSON parse failure**
Claude may produce output with a sentence of explanation prepended to the JSON object. `extractJson()` handles this with brace-depth tracking that skips non-JSON `{...}` prose and finds the first valid JSON object. If the model produces no parseable JSON at all, the item falls back to `classification: "other"` with a note for manual review.

**6. Rate limit / 429 on parallel runs**
`Promise.all` fires 8 agentic loops concurrently. On a capped API key this may produce 429 errors. If this happens, switch `Promise.all` to a sequential `for...of` loop in `runAgent`. Runtime increases ~2–3×.

**7. Runaway agentic loop**
A confused model could keep requesting tool calls indefinitely. The loop is capped at 15 iterations per item. Exceeding the cap throws, which feeds into the catch block and produces a graceful fallback output.

### Production eval framework

| Dimension | Signal |
|---|---|
| Safeguarding recall | Are all P0 items escalated? False negatives are high-stakes |
| Over-escalation rate | Are P1/P2 items incorrectly routed to P0? |
| Tool relevance | Are tool calls appropriate? Slot search on safeguarding items = fail |
| Draft quality | Are replies clear, empathetic, non-clinical, correctly languaged? |
| Schema validity | `npm run validate` pass rate across input variants |
| Latency | Per-item p50/p95 LLM call time; batch completion time |
| Token cost | Input + output tokens per item; cost per batch run |

An automated eval harness would run the agent against a labelled set of synthetic inbox variants and compare outputs against expected classifications, urgencies, and tool sequences — both exact-match checks and LLM-as-judge for draft quality.

---

## What I Chose Not to Build, and Why

**Retry and backoff on LLM errors.**
A 429 or 5xx from the Anthropic API causes the item to fall back to a safe default rather than retrying. For a 2-hour assignment against a capped key with 8 items, retry logic adds complexity without meaningfully changing outcomes. In production: standard exponential backoff wrapper around `client.messages.create`, retrying up to 3 times before falling back.

**Streaming.**
`client.messages.create` is called without streaming. Streaming reduces time-to-first-token but adds complexity to the agentic loop (stream accumulation, partial tool-use detection). Batch triage writes a file — it does not need streaming.

**Multi-turn memory across items.**
Each item is processed independently with no shared state. A production agent might share a provider availability cache (to avoid holding the same slot twice across parallel items) or a patient cache (to avoid duplicate `search_patient` calls). For 8 independent items this was unnecessary.

**Rate-limit-aware concurrency.**
`Promise.all` processes all 8 items in parallel with no throttling. A token-bucket or semaphore wrapper would be appropriate for production with a capped key. Documented as a known risk rather than implemented given the time box.

**Token usage tracking.**
The Anthropic API returns `response.usage` on every call. Accumulating per-item and batch token totals would be straightforward, but surfacing them requires either adding a non-schema field to `ItemOutput` (which would break `npm run validate` against the provided schema) or writing a sidecar file. The sidecar approach is fully designed in `docs/observability-design.md` but not implemented to avoid any risk to the output contract that reviewers test against.

**Per-item confidence scoring.**
The agent does not output a confidence score alongside each triage decision. This would require either a second LLM call for self-assessment or a post-processing layer comparing tool call patterns against known-good sequences.

**A web UI.**
The assignment calls for a CLI agent that writes JSON. A UI would have been significant additional scope without rubric benefit.

---

## What I Would Do With Another 4 Hours

**1. LangGraph state machine for deterministic routing (~90 min)**
The current agent relies on the LLM to follow prompt-based routing rules. A LangGraph state graph would make routing deterministic in code: a P0 item literally cannot reach `find_slots` by graph construction, not just by prompt instruction. Each node would receive only the prompt section relevant to it (safeguarding node, insurance-gate node, slot-search node, etc.), solving the context-size problem naturally — Claude sees a smaller, focused prompt per step rather than the full system prompt on every call. This is the right production architecture.

**2. Retry with exponential backoff on LLM failure (~30 min)**
Wrap `client.messages.create` in a retry helper that catches 429 and 5xx, waits 2^n seconds, and retries up to 3 times. Fall back to safe default only after exhausting retries. Makes the agent resilient to transient API issues without changing any other behavior.

**3. Automated eval harness (~60 min)**
Write a lightweight harness: for each of the 8 items, define expected `classification`, `urgency`, and required tool names. Run the agent and diff actual vs. expected. Report pass/fail per item and per dimension rather than reading `output.json` manually. This turns the per-item spot checks in `docs/proofs/phase-2/verification-report.md` into automated assertions that catch regressions across prompt changes.

**4. Token usage sidecar file (~45 min)**
Accumulate `response.usage.input_tokens` and `response.usage.output_tokens` across every LLM call in each agentic loop. Write a sidecar `output.tokens.json` with per-item breakdowns and batch totals. Print a summary table to stdout at the end of the run. The full design is in `docs/observability-design.md`. This does not touch the validated `output.json` schema.

**5. Per-item token budget enforcement (~45 min)**
The current `max_tokens: 4096` only caps Claude's output per response — it does not control cost. The real spend is on input tokens, which compound with every loop iteration because the full message history (system prompt + all previous tool calls + all results) is resent each time. A 5-iteration loop on one item can easily consume 30k–50k input tokens. In production, the right approach is to accumulate `response.usage.input_tokens` across iterations, and if a single item exceeds a budget threshold (e.g. 80k tokens), abort the loop early and return a fallback rather than continuing to spend. The existing iteration cap of 15 is a proxy for this — it bounds call count but not token spend directly. This pairs naturally with the token tracking sidecar described in item 4 above: once you can see what each item costs, you can set meaningful per-item budgets.

**6. Code-level tool preconditions (~45 min)**
Currently, rules like "only call `hold_slot` after `verify_insurance` returns `in_network`" live in the system prompt. The right production pattern is to enforce these in `dispatchTool` — track state within each item's loop (e.g. record the insurance verification result), and reject a `hold_slot` call in code if the precondition is not met, regardless of what the model requested. This moves the highest-risk routing decisions from "model follows instructions" to "code enforces invariants."

**7. Slot de-duplication across parallel items (~30 min)**
Items 1, 4, and 7 each call `find_slots` and `hold_slot` in parallel. Two items can hold the same slot simultaneously. A shared `Set<string>` of held slot IDs, protected by an async mutex, would prevent duplicate holds without serialising the entire batch.
