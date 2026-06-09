import Anthropic from "@anthropic-ai/sdk";

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_patient",
    description: "Search for an existing patient record by name and/or date of birth.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Patient full name" },
        dob: { type: "string", description: "Date of birth in YYYY-MM-DD format" },
      },
    },
  },
  {
    name: "verify_insurance",
    description: "Verify insurance coverage status for a payer and member ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        payer: { type: "string", description: "Insurance payer name (e.g. 'Blue Cross Blue Shield PPO')" },
        member_id: { type: "string", description: "Insurance member ID" },
      },
    },
  },
  {
    name: "lookup_policy",
    description: "Look up Cedar Kids Therapy internal policy on a specific topic.",
    input_schema: {
      type: "object" as const,
      properties: {
        topic: {
          type: "string",
          enum: ["service_lines", "insurance", "safeguarding", "clinical_advice", "scheduling", "cancellation", "language_access"],
          description: "Policy topic to look up",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "find_slots",
    description: "Find available appointment slots. Returns up to 5 slots for staff review. Does NOT schedule.",
    input_schema: {
      type: "object" as const,
      properties: {
        discipline: {
          type: "string",
          enum: ["SLP", "OT", "PT"],
          description: "Therapy discipline",
        },
        preferences: { type: "string", description: "Family availability preferences (e.g. 'after school Tuesdays or Thursdays')" },
        language: { type: "string", description: "Preferred provider language, e.g. 'es' for Spanish" },
      },
    },
  },
  {
    name: "hold_slot",
    description: "Place a soft hold on a slot for staff review. Call ONLY after find_slots returns a valid slot_id. ONLY for in-network referrals with complete patient info. Creates a pending_review hold, does NOT confirm an appointment.",
    input_schema: {
      type: "object" as const,
      properties: {
        slot_id: { type: "string", description: "Slot ID from a prior find_slots result" },
        patient_ref: { type: "string", description: "Patient name or identifier" },
      },
      required: ["slot_id", "patient_ref"],
    },
  },
  {
    name: "create_task",
    description: "Create a staff task for a required follow-up action.",
    input_schema: {
      type: "object" as const,
      properties: {
        assignee: {
          type: "string",
          enum: ["front_desk", "intake", "billing", "clinical_lead"],
          description: "Staff role to assign the task to",
        },
        title: { type: "string", description: "Short task title" },
        due: { type: "string", description: "Due date in YYYY-MM-DD format" },
        notes: { type: "string", description: "Detailed task notes for the assignee" },
      },
      required: ["assignee", "title", "due", "notes"],
    },
  },
  {
    name: "draft_message",
    description: "Create a draft message for staff review before sending. Does NOT send the message. Do not imply the message was sent.",
    input_schema: {
      type: "object" as const,
      properties: {
        recipient: { type: "string", description: "Recipient name or contact (e.g. email address or phone)" },
        channel: {
          type: "string",
          enum: ["portal", "email", "phone"],
          description: "Communication channel",
        },
        body: { type: "string", description: "Full message body text — clear, empathetic, concise, and operationally useful" },
        language: {
          type: "string",
          enum: ["en", "es"],
          description: "Message language (default en)",
        },
      },
      required: ["recipient", "channel", "body"],
    },
  },
  {
    name: "escalate",
    description: "Escalate an item for immediate human review. Use P0 for safeguarding/imminent harm. Use P1 for same-day operational issues.",
    input_schema: {
      type: "object" as const,
      properties: {
        item_id: { type: "string", description: "The inbox item ID being escalated" },
        reason: { type: "string", description: "Specific reason for escalation" },
        severity: {
          type: "string",
          enum: ["P0", "P1"],
          description: "P0 = safeguarding/imminent harm (same-hour review). P1 = same-day operational issue.",
        },
      },
      required: ["item_id", "reason", "severity"],
    },
  },
];
