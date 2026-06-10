import { createHash } from "node:crypto";
import { z } from "zod";

// cos.extract_commitments v1 — prompt + schema live together, versioned as a
// module (CLAUDE.md conventions). The eval harness imports this by version;
// the active version is referenced only in ./active.ts.

export const ExtractedCommitment = z.object({
  direction: z.enum(["owed_by_me", "owed_to_me"]),
  counterparty_name: z.string().nullable(),
  counterparty_email: z.string().nullable(),
  description: z.string().min(1),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  due_date_basis: z.enum(["explicit", "inferred"]).nullable(),
  confidence: z.number().min(0).max(1),
  source_excerpt: z.string().min(1),
});

export const ExtractionOutput = z.object({
  commitments: z.array(ExtractedCommitment),
});
export type ExtractedCommitmentT = z.infer<typeof ExtractedCommitment>;
export type ExtractionOutputT = z.infer<typeof ExtractionOutput>;

export interface ExtractionInput {
  sourceType: "email" | "chat" | "calendar" | "manual";
  ownerName: string;
  ownerEmails: string[];
  from?: string;
  to?: string;
  subject?: string;
  occurredAt: string; // ISO timestamp of the source content
  body: string;
}

const SYSTEM = `You extract commitments from one piece of source content (an email, chat note, or similar) belonging to a single user, called the OWNER.

A commitment is a specific, actionable obligation that one identifiable party owes another: a deliverable, an action, an answer, an introduction, a payment — something whose completion can be verified. It must be stated or clearly accepted in the content, not merely wished for.

Directions are always relative to the OWNER:
- "owed_by_me": the OWNER promised someone something ("I'll send you the contract Friday" written by the owner; "can you intro me to Priya?" accepted by the owner).
- "owed_to_me": someone promised the OWNER something ("I'll get you the revised deck by Thursday" written to the owner).

DO NOT extract:
- aspirational or social pleasantries ("we should grab coffee sometime", "let's catch up soon");
- newsletters, marketing, automated notifications, receipts;
- FYI status updates and reports of already-completed work ("I sent the deck yesterday");
- pure scheduling chatter (picking a meeting time — the calendar already tracks the meeting);
- vague intentions with no deliverable ("let's sync on this", "we'll figure it out");
- obligations between two third parties that don't involve the OWNER.

Due dates:
- Resolve relative expressions ("by Thursday", "end of week", "tomorrow") against OCCURRED AT, using its weekday. "By Thursday" means the next Thursday strictly after the occurred-at date.
- basis "explicit" when a date or weekday is stated; "inferred" when deduced from context ("before the board meeting"); null when there is no time anchor at all (and due_date null too).

Other fields:
- counterparty_email / counterparty_name: the OTHER party (never the owner). Use the email when present in the headers; name otherwise; null when truly unknown.
- description: short imperative gist, e.g. "send revised deck", "intro Dana to Priya".
- source_excerpt: the shortest verbatim quote from the body containing the commitment.
- confidence: ≥0.9 for an explicit promise, ~0.7 for strongly implied, ≤0.5 for ambiguous.

Precision over recall: a noisy queue is worse than a missed item. Most messages contain ZERO commitments — return an empty list unless something genuinely qualifies. Always respond by calling the tool exactly once.`;

function renderPrompt(input: ExtractionInput): string {
  const occurredDate = new Date(input.occurredAt);
  const weekday = occurredDate.toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "America/Denver",
  });
  const lines = [
    `SOURCE TYPE: ${input.sourceType}`,
    `OWNER: ${input.ownerName} <${input.ownerEmails.join(", ")}>`,
    ...(input.from ? [`FROM: ${input.from}`] : []),
    ...(input.to ? [`TO: ${input.to}`] : []),
    ...(input.subject ? [`SUBJECT: ${input.subject}`] : []),
    `OCCURRED AT: ${input.occurredAt} (${weekday})`,
    ``,
    `BODY:`,
    input.body,
  ];
  return lines.join("\n");
}

export const extractCommitmentsV1 = {
  task: "cos.extract_commitments" as const,
  version: "v1" as const,
  schema: ExtractionOutput,
  system: SYSTEM,
  renderPrompt,
  contentHash(): string {
    return createHash("sha256")
      .update(SYSTEM)
      .update(JSON.stringify(z.toJSONSchema(ExtractionOutput)))
      .digest("hex");
  },
};

export type ExtractionPromptModule = typeof extractCommitmentsV1;
