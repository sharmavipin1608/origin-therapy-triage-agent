# Phase 1: Foundation & Agentic Core

## Goal
A fully working end-to-end agent that processes all 8 inbox items, makes meaningful tool calls, and passes `npm run validate`.

---

## Scope

| In scope | Out of scope |
|---|---|
| Install `@anthropic-ai/sdk` | Multi-turn memory across items |
| `.env` setup for API key | Retry/backoff logic |
| Full agentic loop in `agent.ts` | README sections |
| All 8 items produce valid `ItemOutput` | Edge-case prompt tuning (Phase 2) |
| `npm run validate` passes | |

---

## Architecture

```
runAgent(inbox: InboxItem[])
  │
  ├─ Promise.all → [processItem(item), ...]   ← parallel per item
  │
  └─ processItem(item)
       │
       ├─ withItemContext(item.id, async () => {
       │
       ├─ Build messages: system prompt + user message (item JSON)
       │
       ├─ Agentic loop:
       │     while stop_reason === "tool_use"
       │       ├─ Execute requested tools via dispatchTool()
       │       └─ Append tool results → next LLM call
       │
       ├─ Parse Claude's final JSON response → ItemOutput fields
       │
       ├─ tools_called: getToolCallsForItem(item.id)   ← must use this
       │
       └─ Return ItemOutput
```

### Key constraints satisfied by design
- `withItemContext` wraps ALL tool calls per item — enforced by the loop structure
- `getToolCallsForItem(item.id)` is called AFTER the loop, replacing `tools_called`
- `requires_human_review: true` is hardcoded (validator requires it for all items)
- `buildBatchOutput` called in `index.ts` (already wired, not touched)

---

## Files Changed

| File | Change |
|---|---|
| `package.json` | Add `@anthropic-ai/sdk` dependency |
| `.env` | Create with `ANTHROPIC_API_KEY` (gitignored) |
| `src/agent.ts` | Full implementation |

`src/index.ts`, `src/tools.ts`, `src/types.ts` — **not touched**.

---

## Implementation Plan

### 1. Environment
```
npm install @anthropic-ai/sdk dotenv
```
`.env`:
```
ANTHROPIC_API_KEY=sk-ant-...
```
Load in `agent.ts` via `import 'dotenv/config'` at top (works in ESM).

**ESM import paths**: `tsconfig.json` uses `NodeNext` module resolution — all local imports need `.js` extensions:
```typescript
import { withItemContext, getToolCallsForItem, ... } from './tools.js';
import type { InboxItem, ItemOutput } from './types.js';
```

### 2. Tool Definitions (passed to Anthropic API)
Mirror all 8 tools from `tools.ts` as Anthropic tool schemas. These tell Claude what it can call.

**Critical: enum-constrained args must be specified as enums in the schema** — otherwise Claude will hallucinate invalid values that crash `dispatchTool`.

| Tool | Key args | Enum constraints |
|---|---|---|
| `search_patient` | `name`, `dob` | — |
| `verify_insurance` | `payer`, `member_id` | — |
| `lookup_policy` | `topic` | `"service_lines" \| "insurance" \| "safeguarding" \| "clinical_advice" \| "scheduling" \| "cancellation" \| "language_access"` |
| `find_slots` | `discipline`, `preferences`, `language` | `discipline`: `"SLP" \| "OT" \| "PT"` |
| `hold_slot` | `slot_id`, `patient_ref` | — (slot_id must come from a prior `find_slots` result) |
| `create_task` | `assignee`, `title`, `due`, `notes` | `assignee`: `"front_desk" \| "intake" \| "billing" \| "clinical_lead"` |
| `draft_message` | `recipient`, `channel`, `body`, `language` | `channel`: `"portal" \| "email" \| "phone"`, `language`: `"en" \| "es"` |
| `escalate` | `item_id`, `reason`, `severity` | `severity`: `"P0" \| "P1"` |

**`hold_slot` pre-condition**: only call after a successful `find_slots` with a valid `slot_id`. Only appropriate for in-network referrals with complete patient info. Do NOT hold slots for out-of-network, safeguarding, incomplete, or clinical-question items.

### 3. System Prompt (key sections)

```
You are a triage agent for Cedar Kids Therapy, a pediatric therapy practice.
Process each inbox item and decide what tools to call, then output a JSON object.

URGENCY LEVELS:
- P0: safeguarding / harm / abuse disclosure → escalate immediately, same-hour human review
- P1: same-day operational issue (cancellation, rescheduling today)
- P2: normal intake, new referral, billing, scheduling (default)
- P3: low-priority admin, FYI

RULES:
- Do NOT draft messages that imply they were sent
- Do NOT provide clinical advice in replies
- Do NOT schedule appointments (find_slots and hold_slot are for staff review only)
- All items require_human_review = true
- For incomplete referrals, create a task to gather missing info
- For Spanish-speaking families, use language="es" in draft_message and find_slots

AFTER tool calls, output ONLY a JSON object with these fields:
{classification, urgency, extracted_intake, missing_info,
 recommended_next_action, draft_reply, escalation, decision_rationale}

NOTE: do NOT include task_ids — those are assembled from tool results by the system.
```

### 4. dispatchTool() function
```typescript
async function dispatchTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "search_patient": return search_patient(args as ...)
    case "verify_insurance": return verify_insurance(args as ...)
    // ... etc
    default: return { error: `Unknown tool: ${name}` }
  }
}
```

### 5. LLM Output Validation
Before assembling `ItemOutput`, validate Claude's parsed JSON. `ajv` is already a project dependency — use it.

**What Claude produces** (fields we ask it for):
```
classification, urgency, extracted_intake, missing_info,
recommended_next_action, draft_reply, escalation, decision_rationale
```

**What can go wrong:**
- `JSON.parse` throws (Claude adds prose before/after the `{}`)
- Wrong enum value (`"p0"` instead of `"P0"`, or `"new referral"`)
- Missing required field (`decision_rationale` omitted)
- `escalation` is `{}` instead of `null` or `{ reason, severity }`

**Mitigation — two layers:**

**Layer 1 — Safe JSON extraction:**
```typescript
function extractJson(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON object found in LLM response");
  return JSON.parse(match[0]);
}
```

**Layer 2 — Field-level validation with fallback:**
Validate the parsed object has the required fields and correct enum values.
If a field is invalid/missing, substitute a safe default and note it in `decision_rationale` so a reviewer can see it degraded gracefully rather than crashing.

```typescript
function validateLlmOutput(raw: unknown, itemId: string): ValidatedOutput {
  // check classification is a known enum value, else fallback to "other"
  // check urgency is P0/P1/P2/P3, else fallback to "P2"
  // check escalation shape if non-null
  // ensure decision_rationale is a non-empty string
}
```

This keeps `npm run validate` passing even if Claude drifts on one item.

### 6. Output Assembly
During the loop, collect task IDs directly from tool results (not from result_summary parsing):
```typescript
const collectedTaskIds: string[] = [];
// inside dispatchTool, after create_task:
if (name === "create_task") {
  collectedTaskIds.push(result.data.task_id);
}
```

After the loop ends (`stop_reason === "end_turn"`), Claude's last text message contains the JSON. Parse it, then:
```typescript
const toolsCalled = getToolCallsForItem(item.id);
return {
  item_id: item.id,
  ...parsedJson,
  tools_called: toolsCalled,         // exact trace entries, unchanged
  requires_human_review: true,       // always true per validator
  task_ids: collectedTaskIds,        // collected live during loop
};
```

---

## Validator Constraints & How We Satisfy Them

| Validator check | How satisfied |
|---|---|
| Schema valid JSON shape | TypeScript types + JSON.parse of Claude output |
| Every input item has exactly one output | `Promise.all` over all 8 items |
| `requires_human_review = true` for all | Hardcoded |
| Summary counts correct | `buildBatchOutput()` computes these |
| ≥3 distinct tool names across batch | LLM will call: `verify_insurance`, `escalate`, `create_task`, `draft_message`, `find_slots` etc. |
| No `schedule_appointment` / `send_message` | Not in tool definitions |
| Every `tools_called` entry matches trace | `getToolCallsForItem()` returns exact trace entries |
| Every non-exempt trace entry in output | `getToolCallsForItem()` collects everything |

---

## Verification Steps

### After `npm install`:
```bash
npm run typecheck   # → no errors
```

### After implementing `agent.ts`:
```bash
npm run typecheck   # → no TS errors
```

### End-to-end:
```bash
npm run triage
# Expected: runs in <2 min, writes output.json, no unhandled exceptions

npm run validate
# Expected: "Validation passed."

# Spot checks (manual):
# item_2 → urgency: "P0", classification: "safeguarding", escalation: non-null
# item_8 → urgency: "P1", classification: "scheduling"
# item_3 → tools_called includes verify_insurance with out_of_network result
# item_7 → tools_called includes find_slots with language: "es" OR draft_message with language: "es"
# distinct tool names across all items ≥ 3
```

---

## What This Phase Does NOT Do

**Phase 2 — Domain Quality**
The validator is a pass/fail gate, but the rubric is 100 points. Phase 1 may produce a valid but wrong urgency for item_2 (safeguarding → must be P0) or miss the Spanish-speaker slot search for item_7. Phase 2 is prompt tuning to ensure all 8 items get the *right* decisions, not just structurally valid ones. Covers: safety and domain judgment (25% of rubric) + tool orchestration quality (25%).

**Phase 3 — README & Submission**
The README is 15% of the rubric and requires 6 specific sections:
1. How to run
2. Stack and runtime
3. Architecture
4. Failure modes and production eval
5. What I chose not to build, and why
6. What I would do with another 4 hours

Also: commit the final `output.json` to the repo (explicitly required by the assignment).

**Not in scope at all (by design):**
- Retry/backoff on LLM error
- Streaming (not needed for batch)
- Multi-turn memory across items

**Known risk — concurrency on capped key:**
`Promise.all` fires 8 agentic loops in parallel. Each loop may make 2–4 LLM calls. If the provided API key has a low rate limit, some items may get 429 errors and produce no output, which fails `validateItemCoverage`. If this happens during testing, switch to sequential `for...of` processing as a fallback.
