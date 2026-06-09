# Observability: Per-Item Token Usage Tracking

## Goal

Track how many tokens each agent invocation burns, broken down by item and by LLM call within each item's agentic loop. Surface this data in two ways:

1. A sidecar file `output.tokens.json` — per-item breakdown and batch totals, not validated by `npm run validate`.
2. A stdout summary table — printed at the end of every `npm run triage` run.

---

## What the Anthropic API Already Gives Us

Every `client.messages.create()` call returns a `response` object. That object includes:

```typescript
response.usage: {
  input_tokens: number,   // tokens in the messages[] array + system prompt
  output_tokens: number   // tokens in the response content
}
```

This is available on every call — both the initial call and each subsequent call in the `while (stop_reason === "tool_use")` loop. Each item typically makes 2–5 LLM calls:

- Call 1: initial triage (may return `tool_use`)
- Calls 2–N: one per round-trip of tool results, until `stop_reason === "end_turn"`

No additional API configuration is required. The field is always populated.

---

## Design

### What to accumulate

Inside `processItem`, maintain a per-item accumulator that grows with every `client.messages.create()` call:

```typescript
interface TokenAccumulator {
  input_tokens: number;
  output_tokens: number;
  llm_calls: number;
}
```

After the loop ends:

```typescript
const total_tokens = accumulator.input_tokens + accumulator.output_tokens;
```

### Where to put the data

Two options were considered:

**Option A — Add `token_usage` to `ItemOutput`**

Pros: single file, data is co-located with the triage result.
Cons: `ItemOutput` is defined in `types.ts` and must match `schema/output.schema.json`. Adding `token_usage` requires updating both. The `npm run validate` schema check would then require the field. If a caller (reviewer's CI, hidden input variants) runs `npm run validate` and the schema version does not match, validation fails. This couples observability data to the correctness-gating schema.

**Option B — Sidecar file `output.tokens.json`**

Pros: zero schema impact; `npm run validate` never sees this file; the `ItemOutput` type and schema remain unchanged; token data can be toggled or removed without touching validated output.
Cons: data is in a separate file; a reader must open two files to see full item details.

**Decision: Option B (sidecar file).** The schema is a hard constraint enforced by the validator. Keeping observability data outside the validated schema is the safer, more maintainable choice. See D030.

---

## Sidecar File Format: `output.tokens.json`

```json
{
  "generated_at": "2026-06-09T08:00:00.000Z",
  "model": "claude-sonnet-4-6",
  "batch_totals": {
    "input_tokens": 42800,
    "output_tokens": 6340,
    "total_tokens": 49140,
    "llm_calls": 28
  },
  "items": [
    {
      "item_id": "item_1",
      "input_tokens": 6200,
      "output_tokens": 980,
      "total_tokens": 7180,
      "llm_calls": 4
    },
    {
      "item_id": "item_2",
      "input_tokens": 4100,
      "output_tokens": 610,
      "total_tokens": 4710,
      "llm_calls": 3
    }
  ]
}
```

The path mirrors the `--output` flag: if output is `output.json`, tokens go to `output.tokens.json` (same directory, `.tokens.` infix).

---

## Stdout Summary Format

At the end of the run, after writing both output files, print a table to stdout:

```
Token usage summary
───────────────────────────────────────────────────────────────
Item       Input     Output    Total     LLM calls
───────────────────────────────────────────────────────────────
item_1     6,200        980    7,180     4
item_2     4,100        610    4,710     3
item_3     5,400        720    6,120     3
item_4     7,800      1,050    8,850     5
item_5     4,600        590    5,190     2
item_6     4,200        530    4,730     2
item_7     7,100        980    8,080     5
item_8     5,400        640    6,040     3
───────────────────────────────────────────────────────────────
TOTAL     44,800      6,100   50,900    27
───────────────────────────────────────────────────────────────
Tokens file: output.tokens.json
```

Numbers above are illustrative estimates. Actual values depend on system prompt length, item body length, and tool result sizes.

---

## Implementation Plan

### 1. Add `TokenUsage` and `ItemTokenUsage` types to `src/types.ts`

```typescript
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  llm_calls: number;
}

export interface BatchTokenReport {
  generated_at: string;
  model: string;
  batch_totals: TokenUsage;
  items: Array<{ item_id: string } & TokenUsage>;
}
```

No changes to `ItemOutput`, `BatchOutput`, or any existing type.

### 2. Modify `processItem` in `src/agent.ts`

Add an accumulator inside `withItemContext`:

```typescript
// Before the first client.messages.create call:
let inputTokens = 0;
let outputTokens = 0;
let llmCalls = 0;

// After every client.messages.create call (both the initial and loop calls):
inputTokens += response.usage.input_tokens;
outputTokens += response.usage.output_tokens;
llmCalls += 1;
```

Change the return type of `processItem` to carry token data alongside the `ItemOutput`:

```typescript
interface ProcessItemResult {
  output: ItemOutput;
  tokenUsage: { item_id: string } & TokenUsage;
}
```

Or — simpler, avoiding a new interface — return a tuple:

```typescript
async function processItem(
  item: InboxItem,
  client: Anthropic,
): Promise<[ItemOutput, { item_id: string; input_tokens: number; output_tokens: number; total_tokens: number; llm_calls: number }]>
```

Either form keeps `ItemOutput` unchanged.

### 3. Modify `runAgent` in `src/agent.ts`

Change the signature to return both the item outputs and the token report:

```typescript
export async function runAgent(
  inbox: InboxItem[],
): Promise<{ items: ItemOutput[]; tokenReport: BatchTokenReport }>
```

Inside `runAgent`:

```typescript
const results = await Promise.all(inbox.map((item) => processItem(item, client)));
const items = results.map(([output]) => output);
const tokenItems = results.map(([, usage]) => usage);

const batchTotals: TokenUsage = tokenItems.reduce(
  (acc, u) => ({
    input_tokens: acc.input_tokens + u.input_tokens,
    output_tokens: acc.output_tokens + u.output_tokens,
    total_tokens: acc.total_tokens + u.total_tokens,
    llm_calls: acc.llm_calls + u.llm_calls,
  }),
  { input_tokens: 0, output_tokens: 0, total_tokens: 0, llm_calls: 0 },
);

const tokenReport: BatchTokenReport = {
  generated_at: new Date().toISOString(),
  model: "claude-sonnet-4-6",
  batch_totals: batchTotals,
  items: tokenItems,
};

return { items, tokenReport };
```

### 4. Modify `src/index.ts`

Derive the tokens output path from the `--output` flag:

```typescript
function tokensPath(outputPath: string): string {
  return outputPath.replace(/\.json$/, ".tokens.json");
}
```

After writing `output.json`:

```typescript
const { items, tokenReport } = await runAgent(inbox);
const output = buildBatchOutput(items);

// Write validated output
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);

// Write token sidecar (not validated)
const tokensFilePath = tokensPath(outputPath);
writeFileSync(tokensFilePath, `${JSON.stringify(tokenReport, null, 2)}\n`);

// Print stdout summary
printTokenSummary(tokenReport, tokensFilePath);
```

`printTokenSummary` is a pure formatting function in `index.ts` — no dependencies, no test overhead.

### 5. Fallback item token usage

The `catch` block in `processItem` currently returns a fallback `ItemOutput`. It should also return a zero-usage token entry so the tuple shape is consistent:

```typescript
// In the catch block:
const zeroUsage = {
  item_id: item.id,
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  llm_calls: 0,
};
return [fallbackItemOutput, zeroUsage];
```

This prevents the token accumulator from crashing on a failed item.

---

## Verification Steps

```bash
# 1. Run the agent
npm run triage
# Expected: stdout includes the token summary table

# 2. Verify sidecar file exists
ls -la output.tokens.json
# Expected: file present, non-empty

# 3. Inspect sidecar structure
node -e "const t = JSON.parse(require('fs').readFileSync('output.tokens.json','utf8')); console.log(Object.keys(t))"
# Expected: ["generated_at","model","batch_totals","items"]

# 4. Verify 8 items in sidecar
node -e "const t = JSON.parse(require('fs').readFileSync('output.tokens.json','utf8')); console.log(t.items.length)"
# Expected: 8

# 5. Verify batch totals are sum of item totals
node -e "
const t = JSON.parse(require('fs').readFileSync('output.tokens.json','utf8'));
const sumIn = t.items.reduce((a,i) => a + i.input_tokens, 0);
const sumOut = t.items.reduce((a,i) => a + i.output_tokens, 0);
console.log(sumIn === t.batch_totals.input_tokens, sumOut === t.batch_totals.output_tokens);
"
# Expected: true true

# 6. Confirm output.json still passes validation (sidecar must not affect it)
npm run validate
# Expected: "Validation passed."

# 7. TypeScript check
npm run typecheck
# Expected: no errors

# 8. Unit tests
npm test
# Expected: all 38 pass (token changes do not touch validation functions)
```

---

## Decisions

### D030 — Token data goes in a sidecar file, not inside `ItemOutput`
**Date:** 2026-06-09
**Decision:** `token_usage` is written to `output.tokens.json`, a separate file not included in `npm run validate`. It is not added to `ItemOutput` or `BatchOutput`.
**Reason:** `ItemOutput` is validated by `schema/output.schema.json`. Adding a new field requires updating the schema and all validation logic. If the reviewer runs `npm run validate` against a schema that does not include `token_usage`, it would either fail (if the schema is strict about additional properties) or silently pass with an extra field (if not). Either outcome is a risk. Separating observability data from correctness-gated output is the clean architectural boundary.
**Alternatives considered:** Add `token_usage` to `ItemOutput` with `additionalProperties: true` in the schema — works but mixes operational metadata into the clinical triage record; the token data is not part of the triage decision and should not be in the same document.

---

### D031 — `runAgent` return type changes from `ItemOutput[]` to `{ items, tokenReport }`
**Date:** 2026-06-09
**Decision:** The `runAgent` export changes its return type to carry both the item outputs and the `BatchTokenReport`. The caller (`src/index.ts`) destructures the result.
**Reason:** Alternatives (module-level mutable accumulator, a separate `getTokenReport()` call) introduce shared mutable state or require coordinating two async calls. A structured return value from `runAgent` is explicit, testable, and does not require any globals.
**Alternatives considered:** Module-level `tokenAccumulator` singleton in `agent.ts` — would work but makes `runAgent` stateful and non-reentrant; a structured return is cleaner and easier to test.

---

### D032 — Token summary is printed to stdout, not stderr
**Date:** 2026-06-09
**Decision:** The token summary table is printed to `process.stdout`, not `process.stderr`.
**Reason:** `stderr` is conventionally for errors and warnings. The token summary is informational operational output — analogous to a build tool printing a size report. It belongs on stdout alongside the normal completion message. If a caller wants to suppress it, they can pipe stdout.
**Alternatives considered:** Print to stderr — would separate it from normal output, but the token summary is not an error condition; stdout is the right channel.

---

### D033 — `output.tokens.json` path is derived from the `--output` flag, not hardcoded
**Date:** 2026-06-09
**Decision:** The tokens sidecar path is computed as `outputPath.replace(/\.json$/, ".tokens.json")`. If the reviewer passes `--output results/run1.json`, the sidecar goes to `results/run1.tokens.json` automatically.
**Reason:** The assignment explicitly says "do not hardcode input, output, or trace paths." Hardcoding `output.tokens.json` while `output.json` is configurable would be inconsistent and would break if the reviewer passes a custom output path.
**Alternatives considered:** Separate `--tokens-output` CLI flag — adds CLI surface area for no benefit; deriving from `--output` is zero-configuration and always correct.
