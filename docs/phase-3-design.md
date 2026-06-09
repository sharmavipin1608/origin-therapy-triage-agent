# Phase 3: README & Submission

## Goal

Complete the README with all 6 required sections and prepare the repository for submission. Phase 3 is the final 15% of the rubric. It is not engineering work — it is documentation, self-evaluation, and packaging.

---

## Scope

| In scope | Out of scope |
|---|---|
| Draft content for all 6 README sections | Code changes |
| Submission checklist | Phase 2 prompt tuning (Phase 2 scope) |
| Verification steps | New tool implementations |
| Decisions D027–D029 | Retry/backoff, streaming, web UI |

---

## The 6 Required README Sections

The following is the actual content to paste into `README.md`, replacing the existing assignment-brief content. Preserve the "How To Run" section that the starter provides (it is already correct); update or add the sections below.

---

### Section 1: How to run

```markdown
## How to Run

**Prerequisites:** Node.js LTS (v20+), an Anthropic API key.

```bash
# 1. Install dependencies
npm install

# 2. Set your API key
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# 3. Run the triage agent
npm run triage
# or with explicit paths:
npm run triage -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl

# 4. Validate output
npm run validate
# or with explicit paths:
npm run validate -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
```

Expected end-to-end runtime: 30–90 seconds (8 items processed in parallel, each making 2–5 LLM calls).

To run the unit test suite (38 tests, no API calls required):
```bash
npm test
```
```

---

### Section 2: Stack and runtime

```markdown
## Stack and Runtime

| Component | Choice |
|---|---|
| Language | TypeScript 5, strict mode |
| Runtime | Node.js LTS (v20+), ESM (`"type": "module"`) |
| LLM provider | Anthropic SDK (`@anthropic-ai/sdk`) |
| Model | `claude-sonnet-4-6` |
| Module resolution | NodeNext (explicit `.js` extensions on local imports) |
| Test runner | Node built-in `node:test` (zero added dependencies) |
| Env loading | `dotenv` (`import 'dotenv/config'`) |
| ID generation | `ulid` (already in starter) |

No framework, no build step. `tsx` runs TypeScript directly via the `npm run triage` script.
```

---

### Section 3: Architecture

```markdown
## Architecture

The agent is a parallel agentic loop. Each inbox item is processed independently and concurrently.

```
src/index.ts
  │
  ├─ parseCliArgs()          reads --input/--output/--trace flags
  ├─ configureTrace()        opens the JSONL audit file
  ├─ runAgent(inbox)
  │     │
  │     └─ Promise.all → [processItem(item), ...]   ← 8 parallel loops
  │
  └─ buildBatchOutput()      assembles summary counts, writes output.json

processItem(item, client)
  │
  ├─ withItemContext(item.id, async () => {
  │
  ├─ Build messages[]        system prompt + user message (raw inbox item JSON)
  │
  ├─ client.messages.create  first LLM call
  │
  ├─ Agentic loop:
  │     while stop_reason === "tool_use"
  │       ├─ Filter ToolUseBlocks from response.content
  │       ├─ dispatchTool(name, args)  → executes the actual tool fn from tools.ts
  │       ├─ Collect task_ids from create_task results
  │       ├─ Append ToolResultBlockParams to messages[]
  │       └─ client.messages.create  next LLM call
  │
  ├─ validateLlmOutput()     two-layer parse + field validation with safe defaults
  ├─ getToolCallsForItem()   pulls exact trace entries for tools_called[]
  │
  └─ Return ItemOutput
```

**Key design properties:**

- **Claude drives tool selection.** The system prompt provides routing rules; the LLM decides which tools to call and in what order. There is no rule-based dispatch table.
- **Audit trace is authoritative.** `tools.ts` records every tool call with a ULID `call_id`, `item_id`, args, result summary, and timestamp. The validator checks the trace against `tools_called[]`; the agent passes `getToolCallsForItem()` through unchanged.
- **Graceful degradation.** `validateLlmOutput()` catches JSON parse failures and invalid enum values, substitutes safe defaults, and notes the fallback in `decision_rationale`. The batch never fails catastrophically on a single bad item.
- **No hardcoded routing.** Classification, urgency, tool sequencing, and draft content come entirely from the LLM given the system prompt. This keeps the agent extensible — adding a new item type means updating the prompt, not the code.
```

---

### Section 4: Failure modes and production eval

```markdown
## Failure Modes and Production Eval

### Known failure modes

**1. Safeguarding misclassification (highest severity)**
A harm disclosure buried in a routine-sounding message (e.g. item_2: "getting rough with him" inside an SLP intake voicemail) can be misread as a new referral if the model focuses on the explicit ask ("speech therapy openings") rather than the embedded signal. Mitigation: the safeguarding rule appears first in the urgency decision tree with explicit trigger phrase examples. Production mitigation would require a dedicated pre-screening pass with a focused zero-shot classifier before the main agentic loop.

**2. Over-escalation**
The model may call `escalate` on item_8 (same-day cancellation) because the subject line says "URGENT!!!" P1 is an operational issue, not a safeguarding event; `escalate` routes to `clinical_lead` and would pollute the escalation log. Mitigation: explicit prompt rule distinguishing P1 operational from P0 clinical.

**3. Language mismatch in slot search**
For Spanish-speaking families, calling `find_slots` without `language="es"` returns English-only providers. This is a silent failure — the tool call succeeds, the output looks valid, but the slot held is for a provider who cannot serve the family. Mitigation: prompt rule makes `language="es"` mandatory; production mitigation would enforce this at the tool-dispatch layer.

**4. Hallucinated slot IDs in `hold_slot`**
If the model calls `hold_slot` with a fabricated `slot_id` rather than one returned from a preceding `find_slots`, the slot hold is meaningless. Mitigation: tool description explicitly states the slot_id must come from a prior `find_slots` result; the hold_slot checklist in the prompt requires this.

**5. JSON parse failure**
Claude may produce output that is mostly JSON but has a sentence of explanation prepended. `extractJson()` handles this with a regex strip. If the model produces no JSON at all (e.g. a refusal or a pure prose response), the item falls back to a safe default with `classification: "other"` and a note for manual review.

**6. Rate limit / 429 on parallel runs**
`Promise.all` fires 8 agentic loops concurrently. On a capped API key this may produce 429 errors. Fallback: switch `Promise.all` to a sequential `for...of` loop. Runtime increases ~2–3×.

### Production eval framework

For a production version of this agent, the following eval dimensions would matter:

| Dimension | Signal |
|---|---|
| Safeguarding recall | Are all P0 items correctly escalated? False negatives here are high-stakes |
| Over-escalation rate | Are P1/P2 items incorrectly escalated to P0? |
| Tool relevance | Are tool calls appropriate and non-performative? (slot search on safeguarding items = fail) |
| Draft quality | Are replies clear, empathetic, non-clinical, and correctly languaged? |
| Schema validity | `npm run validate` pass rate across input variants |
| Latency | Per-item p50/p95 LLM call time; batch completion time |
| Token cost | Input + output tokens per item; cost per batch run |

An automated eval harness would run the agent on a labelled set of synthetic inbox variants and compare outputs against expected classifications, urgencies, tool sequences, and draft language using both exact-match checks and LLM-as-judge for draft quality.
```

---

### Section 5: What I chose not to build, and why

```markdown
## What I Chose Not to Build, and Why

**Retry and backoff on LLM errors**
A 429 or 5xx from the Anthropic API causes the item to fall back to a safe default output rather than retrying. For a 2-hour assignment against a capped key with 8 items, retry logic adds complexity without meaningfully changing outcomes. In production this would be a standard exponential backoff wrapper around `client.messages.create`.

**Streaming**
`client.messages.create` is called without streaming. Streaming would reduce time-to-first-token but adds complexity to the agentic loop (stream accumulation, partial tool-use detection). Batch triage does not need streaming; the output is a file, not a real-time UI.

**Multi-turn memory across items**
Each item is processed independently with no shared state between items. A production agent might share provider availability data (to avoid holding the same slot twice) or share a patient cache across items (to avoid duplicate `search_patient` calls). For 8 independent items this was not necessary.

**Rate-limit-aware concurrency**
`Promise.all` processes all 8 items in parallel with no throttling. A token-bucket or semaphore wrapper would be appropriate for production, especially with a capped key. Documented as a known risk rather than implemented given the time box.

**A web UI or dashboard**
The assignment calls for a CLI agent that writes JSON. A UI would have been significant additional scope without rubric benefit.

**Per-item confidence scoring**
The agent does not output a confidence score alongside each triage decision. This would require either a second LLM call asking the model to self-assess, or a post-processing layer comparing tool call patterns against known-good sequences. Worth building for a production system but out of scope here.

**Caching for repeat runs**
Running the agent twice against the same input makes fresh LLM calls both times. Prompt caching (via Anthropic's cache-control headers) or a local result cache would reduce cost on repeated runs. Not implemented.
```

---

### Section 6: What I would do with another 4 hours

```markdown
## What I Would Do With Another 4 Hours

**1. Per-item confidence scoring (~45 min)**
Add a `confidence` field to `ItemOutput` (P0–P2 as low/medium/high, or a 0.0–1.0 float). The simplest implementation: ask the model to include a `confidence` and `confidence_reason` in its final JSON output. Higher-quality implementation: compare tool call sequences against known-correct patterns and compute a rule-based score.

**2. Retry with exponential backoff on LLM failure (~30 min)**
Wrap `client.messages.create` in a retry helper that catches 429 and 5xx responses, waits 2^n seconds, and retries up to 3 times. Fall back to the safe default only after exhausting retries. This makes the agent resilient to transient API issues without changing any other behavior.

**3. Phase 2 prompt tuning verification with labelled eval set (~60 min)**
Write a lightweight eval harness: for each of the 8 items, define the expected `classification`, `urgency`, and key tool names. Run the agent and diff actual vs. expected. Report pass/fail per item rather than reading output.json manually. This turns the per-item spot checks from docs/phase-2-design.md into automated assertions.

**4. Token usage tracking and sidecar file (~45 min)**
Accumulate `response.usage.input_tokens` and `response.usage.output_tokens` across every LLM call in each agentic loop. Write a sidecar file `output.tokens.json` with per-item breakdowns and batch totals. Print a summary table to stdout at the end of the run. This does not touch the validated `output.json` schema. (See `docs/observability-design.md` for full design.)

**5. Slot de-duplication across items (~30 min)**
Items 1, 4, and 7 all call `find_slots` and `hold_slot` in parallel. It is possible that two items hold the same slot simultaneously. A shared `Set<string>` of held slot IDs, protected by an async mutex, would prevent duplicate holds. Requires either a module-level singleton or passing a shared context into `runAgent`.
```

---

## Submission Checklist

Before submitting, verify each item:

- [ ] `npm run triage` completes without errors and writes `output.json`
- [ ] `npm run validate` prints `Validation passed.`
- [ ] `npm test` passes (38 tests, no regressions)
- [ ] `output.json` is committed to the repo (assignment requires this)
- [ ] `.env` is NOT committed (in `.gitignore`)
- [ ] `node_modules/` is NOT committed (in `.gitignore`)
- [ ] `.trace/` is NOT committed (in `.gitignore`)
- [ ] README has all 6 required sections
- [ ] README is accurate (stack, architecture, gaps)
- [ ] Repo is public, or `@nixu` has been granted read access if private
- [ ] Submit the repo link via the assignment submission form

---

## Verification Steps

```bash
# 1. Clean run from scratch
rm -f output.json && npm run triage
# Expected: completes, prints no errors, writes output.json

# 2. Validate
npm run validate
# Expected: "Validation passed."

# 3. Unit tests
npm test
# Expected: all 38 pass

# 4. Check committed files
git status
# Expected: output.json is tracked (committed); .env, node_modules/, .trace/ are absent

# 5. README spot checks
grep -c "^## " README.md
# Expected: ≥ 6 section headers present

# 6. No hardcoded API keys
grep -r "sk-ant-" src/ README.md
# Expected: no output
```

---

> Decisions from this phase are logged in `docs/decisions/decisions.md`.
