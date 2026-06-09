import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateLlmOutput,
  validateEscalation,
  validateExtractedIntake,
  validateDiscipline,
  fallbackOutput,
  applySafetyGuard,
} from "./llm-output-validator.js";
import { dispatchTool } from "./agent.js";

// ─── validateDiscipline ───────────────────────────────────────────────────────

describe("validateDiscipline", () => {
  it("passes a valid single discipline", () => {
    assert.deepEqual(validateDiscipline(["SLP"]), ["SLP"]);
    assert.deepEqual(validateDiscipline(["OT"]), ["OT"]);
    assert.deepEqual(validateDiscipline(["PT"]), ["PT"]);
  });

  it("passes multiple valid disciplines", () => {
    assert.deepEqual(validateDiscipline(["SLP", "OT"]), ["SLP", "OT"]);
  });

  it("filters out invalid values, keeps valid ones", () => {
    assert.deepEqual(validateDiscipline(["SLP", "YOGA"]), ["SLP"]);
  });

  it("returns null for all-invalid array", () => {
    assert.equal(validateDiscipline(["YOGA", "DANCE"]), null);
  });

  it("returns null for empty array", () => {
    assert.equal(validateDiscipline([]), null);
  });

  it("returns null for non-array input", () => {
    assert.equal(validateDiscipline("SLP"), null);
    assert.equal(validateDiscipline(null), null);
    assert.equal(validateDiscipline(undefined), null);
    assert.equal(validateDiscipline(42), null);
  });
});

// ─── validateEscalation ──────────────────────────────────────────────────────

describe("validateEscalation", () => {
  it("passes a valid P0 escalation", () => {
    const input = { reason: "Abuse disclosure", severity: "P0" };
    assert.deepEqual(validateEscalation(input), input);
  });

  it("passes a valid P1 escalation", () => {
    const input = { reason: "Same-day cancellation", severity: "P1" };
    assert.deepEqual(validateEscalation(input), input);
  });

  it("returns null for null input", () => {
    assert.equal(validateEscalation(null), null);
  });

  it("returns null for undefined input", () => {
    assert.equal(validateEscalation(undefined), null);
  });

  it("returns null for empty object", () => {
    assert.equal(validateEscalation({}), null);
  });

  it("returns null when severity is wrong enum value", () => {
    assert.equal(validateEscalation({ reason: "Something", severity: "P2" }), null);
    assert.equal(validateEscalation({ reason: "Something", severity: "p0" }), null);
  });

  it("returns null when reason is missing", () => {
    assert.equal(validateEscalation({ severity: "P0" }), null);
  });

  it("returns null when reason is empty string", () => {
    assert.equal(validateEscalation({ reason: "", severity: "P0" }), null);
  });

  it("returns null for non-object input", () => {
    assert.equal(validateEscalation("P0"), null);
    assert.equal(validateEscalation(42), null);
  });
});

// ─── validateExtractedIntake ─────────────────────────────────────────────────

describe("validateExtractedIntake", () => {
  it("passes through all fields when present", () => {
    const input = {
      child_name: "Emma Lee",
      dob_or_age: "2018-09-04",
      parent_contact: "Daniel Lee, 555-0101",
      discipline: ["SLP"],
      diagnosis_or_concern: "articulation delay",
      payer: "Blue Cross Blue Shield PPO",
      member_id: "BCBS-884200",
    };
    const result = validateExtractedIntake(input);
    assert.equal(result.child_name, "Emma Lee");
    assert.equal(result.dob_or_age, "2018-09-04");
    assert.equal(result.parent_contact, "Daniel Lee, 555-0101");
    assert.deepEqual(result.discipline, ["SLP"]);
    assert.equal(result.diagnosis_or_concern, "articulation delay");
    assert.equal(result.payer, "Blue Cross Blue Shield PPO");
    assert.equal(result.member_id, "BCBS-884200");
  });

  it("returns all-null shape for null input", () => {
    const result = validateExtractedIntake(null);
    assert.equal(result.child_name, null);
    assert.equal(result.dob_or_age, null);
    assert.equal(result.parent_contact, null);
    assert.equal(result.discipline, null);
    assert.equal(result.diagnosis_or_concern, null);
    assert.equal(result.payer, null);
    assert.equal(result.member_id, null);
  });

  it("returns all-null shape for non-object input", () => {
    const result = validateExtractedIntake("not an object");
    assert.equal(result.child_name, null);
    assert.equal(result.discipline, null);
  });

  it("nulls individual fields that are wrong type", () => {
    const result = validateExtractedIntake({
      child_name: 42,
      dob_or_age: true,
      discipline: "SLP",
    });
    assert.equal(result.child_name, null);
    assert.equal(result.dob_or_age, null);
    assert.equal(result.discipline, null);
  });

  it("filters invalid discipline values within the intake", () => {
    const result = validateExtractedIntake({ discipline: ["YOGA"] });
    assert.equal(result.discipline, null);
  });
});

// ─── fallbackOutput ───────────────────────────────────────────────────────────

describe("fallbackOutput", () => {
  it("returns a valid-shape output with all required fields", () => {
    const result = fallbackOutput("item_99", "test error");
    assert.equal(result.classification, "other");
    assert.equal(result.urgency, "P2");
    assert.equal(result.escalation, null);
    assert.equal(result.draft_reply, null);
    assert.ok(Array.isArray(result.missing_info));
    assert.ok(Array.isArray(result.extracted_intake.discipline ?? []));
    assert.ok(typeof result.decision_rationale === "string");
    assert.ok(typeof result.recommended_next_action === "string");
  });

  it("includes the item ID and reason in decision_rationale", () => {
    const result = fallbackOutput("item_42", "JSON parse failed");
    assert.ok(result.decision_rationale.includes("item_42"));
    assert.ok(result.decision_rationale.includes("JSON parse failed"));
  });

  it("extracted_intake has all-null fields", () => {
    const result = fallbackOutput("item_1", "err");
    const intake = result.extracted_intake;
    assert.equal(intake.child_name, null);
    assert.equal(intake.dob_or_age, null);
    assert.equal(intake.parent_contact, null);
    assert.equal(intake.discipline, null);
    assert.equal(intake.diagnosis_or_concern, null);
    assert.equal(intake.payer, null);
    assert.equal(intake.member_id, null);
  });
});

// ─── validateLlmOutput ───────────────────────────────────────────────────────

describe("validateLlmOutput", () => {
  const validInput = {
    classification: "new_referral",
    urgency: "P2",
    extracted_intake: {
      child_name: "Emma Lee",
      dob_or_age: "2018-09-04",
      parent_contact: "Daniel Lee",
      discipline: ["SLP"],
      diagnosis_or_concern: "articulation delay",
      payer: "BCBS PPO",
      member_id: "BCBS-884200",
    },
    missing_info: [],
    recommended_next_action: "Schedule intake",
    draft_reply: "Hi Daniel, ...",
    escalation: null,
    decision_rationale: "Complete referral, insurance in-network.",
  };

  it("passes through a valid complete JSON response", () => {
    const result = validateLlmOutput(JSON.stringify(validInput), "item_1");
    assert.equal(result.classification, "new_referral");
    assert.equal(result.urgency, "P2");
    assert.equal(result.draft_reply, "Hi Daniel, ...");
    assert.equal(result.escalation, null);
    assert.equal(result.decision_rationale, "Complete referral, insurance in-network.");
  });

  it("extracts JSON when there is prose before the opening brace", () => {
    const text = `Here is my analysis of the item:\n\n${JSON.stringify(validInput)}\n\nLet me know if you need more.`;
    const result = validateLlmOutput(text, "item_1");
    assert.equal(result.classification, "new_referral");
    assert.equal(result.urgency, "P2");
  });

  it("extracts correct JSON when prose with braces appears before the object", () => {
    const text = `My analysis {of this item} is:\n${JSON.stringify(validInput)}`;
    const result = validateLlmOutput(text, "item_1");
    assert.equal(result.classification, "new_referral");
  });

  it("extracts first JSON object when prose with braces appears after it", () => {
    const text = `${JSON.stringify(validInput)}\n\nSome trailing prose {with braces} here.`;
    const result = validateLlmOutput(text, "item_1");
    assert.equal(result.classification, "new_referral");
    assert.equal(result.urgency, "P2");
  });

  it("returns fallback when there is no JSON object at all", () => {
    const result = validateLlmOutput("Sorry, I cannot process this item.", "item_1");
    assert.equal(result.classification, "other");
    assert.equal(result.urgency, "P2");
    assert.ok(result.decision_rationale.includes("item_1"));
  });

  it("returns fallback when JSON is malformed (unclosed brace)", () => {
    const result = validateLlmOutput('{"classification": "new_referral"', "item_1");
    assert.equal(result.classification, "other");
    assert.equal(result.urgency, "P2");
  });

  it("coerces invalid classification enum to 'other'", () => {
    const bad = { ...validInput, classification: "new referral" };
    const result = validateLlmOutput(JSON.stringify(bad), "item_1");
    assert.equal(result.classification, "other");
  });

  it("coerces invalid urgency enum to 'P2'", () => {
    const bad = { ...validInput, urgency: "p0" };
    const result = validateLlmOutput(JSON.stringify(bad), "item_1");
    assert.equal(result.urgency, "P2");
  });

  it("coerces another invalid urgency to 'P2'", () => {
    const bad = { ...validInput, urgency: "URGENT" };
    const result = validateLlmOutput(JSON.stringify(bad), "item_1");
    assert.equal(result.urgency, "P2");
  });

  it("uses fallback string when decision_rationale is missing", () => {
    const { decision_rationale: _, ...rest } = validInput;
    const result = validateLlmOutput(JSON.stringify(rest), "item_1");
    assert.ok(typeof result.decision_rationale === "string");
    assert.ok(result.decision_rationale.length > 0);
  });

  it("passes null draft_reply through as null", () => {
    const input = { ...validInput, draft_reply: null };
    const result = validateLlmOutput(JSON.stringify(input), "item_1");
    assert.equal(result.draft_reply, null);
  });

  it("returns null draft_reply when field is non-string", () => {
    const input = { ...validInput, draft_reply: 42 };
    const result = validateLlmOutput(JSON.stringify(input), "item_1");
    assert.equal(result.draft_reply, null);
  });

  it("passes a valid escalation through", () => {
    const input = {
      ...validInput,
      classification: "safeguarding",
      urgency: "P0",
      escalation: { reason: "Abuse disclosure", severity: "P0" },
    };
    const result = validateLlmOutput(JSON.stringify(input), "item_2");
    assert.deepEqual(result.escalation, { reason: "Abuse disclosure", severity: "P0" });
    assert.equal(result.urgency, "P0");
  });

  it("converts invalid escalation shape to null", () => {
    const input = { ...validInput, escalation: { severity: "P0" } };
    const result = validateLlmOutput(JSON.stringify(input), "item_1");
    assert.equal(result.escalation, null);
  });

  it("missing_info non-array becomes empty array", () => {
    const input = { ...validInput, missing_info: "DOB missing" };
    const result = validateLlmOutput(JSON.stringify(input), "item_1");
    assert.deepEqual(result.missing_info, []);
  });

  it("missing_info filters out non-string entries", () => {
    const input = { ...validInput, missing_info: ["DOB", 42, null, "insurance"] };
    const result = validateLlmOutput(JSON.stringify(input), "item_1");
    assert.deepEqual(result.missing_info, ["DOB", "insurance"]);
  });
});

// ─── dispatchTool ─────────────────────────────────────────────────────────────

describe("dispatchTool", () => {
  it("throws for an unknown tool name", async () => {
    await assert.rejects(
      () => dispatchTool("nonexistent_tool", { foo: "bar" }),
      /Unknown tool requested by model/,
    );
  });
});

// ─── applySafetyGuard ────────────────────────────────────────────────────────

describe("applySafetyGuard", () => {
  const base = fallbackOutput("item_x", "test");

  it("passes through a clean P2 output unchanged", () => {
    const input = { ...base, urgency: "P2" as const, classification: "new_referral" as const, escalation: null };
    assert.deepEqual(applySafetyGuard(input), input);
  });

  it("forces urgency to P0 when classification is safeguarding", () => {
    const input = { ...base, urgency: "P2" as const, classification: "safeguarding" as const, escalation: null };
    const result = applySafetyGuard(input);
    assert.equal(result.urgency, "P0");
    assert.equal(result.classification, "safeguarding");
    assert.ok(result.escalation !== null);
    assert.ok(result.decision_rationale.includes("SAFETY GUARD"));
  });

  it("forces classification to safeguarding when urgency is P0", () => {
    const input = { ...base, urgency: "P0" as const, classification: "new_referral" as const, escalation: null };
    const result = applySafetyGuard(input);
    assert.equal(result.classification, "safeguarding");
    assert.equal(result.urgency, "P0");
    assert.ok(result.escalation !== null);
  });

  it("populates escalation when it is null on a P0 item", () => {
    const input = { ...base, urgency: "P0" as const, classification: "safeguarding" as const, escalation: null };
    const result = applySafetyGuard(input);
    assert.ok(result.escalation !== null);
    assert.equal(result.escalation?.severity, "P0");
  });

  it("forces all three fields from a P0 escalation signal alone", () => {
    const input = { ...base, urgency: "P2" as const, classification: "new_referral" as const, escalation: { reason: "abuse", severity: "P0" as const } };
    const result = applySafetyGuard(input);
    assert.equal(result.urgency, "P0");
    assert.equal(result.classification, "safeguarding");
    assert.equal(result.escalation?.severity, "P0");
  });

  it("returns unchanged when all three fields already agree on P0", () => {
    const input = { ...base, urgency: "P0" as const, classification: "safeguarding" as const, escalation: { reason: "harm disclosure", severity: "P0" as const } };
    const result = applySafetyGuard(input);
    assert.deepEqual(result, input);
  });
});

// ─── MAX_ITERATIONS guard (via fallbackOutput shape) ─────────────────────────

describe("iteration cap — fallback shape", () => {
  it("fallbackOutput decision_rationale captures the iteration error message", () => {
    const err = "Exceeded max tool call iterations (15) for item item_3";
    const result = fallbackOutput("item_3", err);
    assert.ok(result.decision_rationale.includes("item_3"));
    assert.ok(result.decision_rationale.includes("Exceeded max tool call iterations"));
    assert.equal(result.urgency, "P2");
    assert.equal(result.classification, "other");
  });
});
