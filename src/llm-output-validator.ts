import type { Classification, Discipline, ExtractedIntake, Urgency } from "./types.js";

export interface ValidatedOutput {
  classification: Classification;
  urgency: Urgency;
  extracted_intake: ExtractedIntake;
  missing_info: string[];
  recommended_next_action: string;
  draft_reply: string | null;
  escalation: { reason: string; severity: "P0" | "P1" } | null;
  decision_rationale: string;
}

const VALID_CLASSIFICATIONS = new Set<string>([
  "new_referral", "existing_patient_request", "scheduling", "clinical_question",
  "billing_question", "missing_paperwork", "provider_followup", "complaint",
  "safeguarding", "spam", "other",
]);

const VALID_URGENCIES = new Set<string>(["P0", "P1", "P2", "P3"]);

function extractJson(text: string): unknown {
  // Walk forward looking for brace-balanced substrings; try JSON.parse on each.
  // This handles non-JSON {braces} in prose before or after the real object.
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf("{", searchFrom);
    if (start === -1) throw new Error("No JSON object found in LLM response");
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        if (--depth === 0) { end = i; break; }
      }
    }
    if (end === -1) throw new Error("No complete JSON object found in LLM response");
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      searchFrom = start + 1;
    }
  }
  throw new Error("No JSON object found in LLM response");
}

export function validateDiscipline(raw: unknown): Discipline[] | null {
  if (!Array.isArray(raw)) return null;
  const valid = (raw as unknown[]).filter((d): d is Discipline =>
    d === "SLP" || d === "OT" || d === "PT",
  );
  return valid.length > 0 ? valid : null;
}

export function validateEscalation(
  raw: unknown,
): { reason: string; severity: "P0" | "P1" } | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.reason !== "string" || !obj.reason) return null;
  if (obj.severity !== "P0" && obj.severity !== "P1") return null;
  return { reason: obj.reason, severity: obj.severity };
}

export function validateExtractedIntake(raw: unknown): ExtractedIntake {
  const obj =
    raw !== null && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};
  return {
    child_name: typeof obj.child_name === "string" ? obj.child_name : null,
    dob_or_age: typeof obj.dob_or_age === "string" ? obj.dob_or_age : null,
    parent_contact:
      typeof obj.parent_contact === "string" ? obj.parent_contact : null,
    discipline: validateDiscipline(obj.discipline),
    diagnosis_or_concern:
      typeof obj.diagnosis_or_concern === "string"
        ? obj.diagnosis_or_concern
        : null,
    payer: typeof obj.payer === "string" ? obj.payer : null,
    member_id: typeof obj.member_id === "string" ? obj.member_id : null,
  };
}

export function fallbackOutput(itemId: string, reason: string): ValidatedOutput {
  return {
    classification: "other",
    urgency: "P2",
    extracted_intake: {
      child_name: null,
      dob_or_age: null,
      parent_contact: null,
      discipline: null,
      diagnosis_or_concern: null,
      payer: null,
      member_id: null,
    },
    missing_info: ["Agent output validation failed — requires manual review"],
    recommended_next_action: "Manual staff review required due to agent processing error.",
    draft_reply: null,
    escalation: null,
    decision_rationale: `Fallback output for ${itemId}: ${reason}`,
  };
}

// Post-LLM safety guard — enforces internal consistency for P0/safeguarding.
// Any single P0 signal (urgency, classification, or escalation severity) forces
// all three to agree. Overrides are noted in decision_rationale for auditability.
export function applySafetyGuard(output: ValidatedOutput): ValidatedOutput {
  const isP0Signal =
    output.urgency === "P0" ||
    output.classification === "safeguarding" ||
    output.escalation?.severity === "P0";

  if (!isP0Signal) return output;

  const overrides: string[] = [];

  const urgency = output.urgency !== "P0"
    ? (overrides.push("urgency forced to P0"), "P0" as const)
    : output.urgency;

  const classification = output.classification !== "safeguarding"
    ? (overrides.push("classification forced to safeguarding"), "safeguarding" as const)
    : output.classification;

  const escalation = output.escalation ?? (
    overrides.push("escalation populated by safety guard"),
    {
      reason: "Safety guard: P0 signal detected — requires immediate clinical lead review",
      severity: "P0" as const,
    }
  );

  if (overrides.length === 0) return output;

  return {
    ...output,
    urgency,
    classification,
    escalation,
    decision_rationale: `[SAFETY GUARD — ${overrides.join(", ")}] ${output.decision_rationale}`,
  };
}

export function validateLlmOutput(text: string, itemId: string): ValidatedOutput {
  let raw: Record<string, unknown>;

  try {
    raw = extractJson(text) as Record<string, unknown>;
  } catch (err) {
    return fallbackOutput(itemId, `JSON extraction failed: ${String(err)}`);
  }

  const classification = VALID_CLASSIFICATIONS.has(raw.classification as string)
    ? (raw.classification as Classification)
    : "other";

  const urgency = VALID_URGENCIES.has(raw.urgency as string)
    ? (raw.urgency as Urgency)
    : "P2";

  const extracted_intake = validateExtractedIntake(raw.extracted_intake);

  const missing_info = Array.isArray(raw.missing_info)
    ? (raw.missing_info as unknown[]).filter(
        (s): s is string => typeof s === "string",
      )
    : [];

  const recommended_next_action =
    typeof raw.recommended_next_action === "string" &&
    raw.recommended_next_action.length > 0
      ? raw.recommended_next_action
      : "Requires staff review.";

  const draft_reply =
    typeof raw.draft_reply === "string" ? raw.draft_reply : null;

  const escalation = validateEscalation(raw.escalation);

  const decision_rationale =
    typeof raw.decision_rationale === "string" &&
    raw.decision_rationale.length > 0
      ? raw.decision_rationale
      : `Processed item ${itemId}.`;

  return {
    classification,
    urgency,
    extracted_intake,
    missing_info,
    recommended_next_action,
    draft_reply,
    escalation,
    decision_rationale,
  };
}
