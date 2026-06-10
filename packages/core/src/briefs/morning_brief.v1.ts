import { createHash } from "node:crypto";
import { z } from "zod";
import type { MorningPacket } from "../context/packet";

// cos.morning_brief v1 — prompt + schema live together, versioned as a module
// (CLAUDE.md conventions). Active version referenced only in ./active.ts.

export const BriefCommitmentItem = z.object({
  commitment_id: z.string().nullable(), // packet commitment id, verbatim — null only for items not in the packet
  description: z.string().min(1),
  due_date: z.string().nullable(),
  why_now: z.string().nullable(),
});
export const BriefScheduleItem = z.object({
  time: z.string().min(1), // local Denver time, e.g. "09:30"
  title: z.string().min(1),
  prep_pointer: z.string().nullable(), // what to glance at before walking in
});
export const BriefWaitingItem = z.object({
  commitment_id: z.string().nullable(),
  description: z.string().min(1),
  counterparty: z.string().nullable(),
  nudge_draft: z.string().min(1), // a DRAFT for the owner to copy — never sent
});
export const BriefSlippedItem = z.object({
  commitment_id: z.string().nullable(),
  description: z.string().min(1),
  due_date: z.string().nullable(),
});

export const MorningBriefOutput = z.object({
  headline: z.string().min(1),
  top_commitments: z.array(BriefCommitmentItem).max(7),
  schedule: z.array(BriefScheduleItem),
  waiting_on: z.array(BriefWaitingItem),
  slipped: z.array(BriefSlippedItem),
});
export type MorningBriefOutputT = z.infer<typeof MorningBriefOutput>;

const SYSTEM = `You are the owner's chief of staff writing their morning brief. You work from ONE context packet (JSON) and nothing else.

Hard rules:
- Level-2 autonomy: you draft and summarize; you never send, schedule, or act. Every "nudge_draft" is a draft the owner may copy — write it in the owner's voice to the counterparty, but you are NOT sending it.
- Ground every item in the packet. When an item comes from a packet commitment, copy its "id" into commitment_id verbatim. Never invent commitments, meetings, or people.
- The packet's commitments arrive pre-ranked (due date, then age, then counterparty recency). top_commitments is your judgment over that ranking — at most 7, fewer is better.
- schedule: one entry per packet schedule item, time as Denver local "HH:MM". prep_pointer only when the packet gives you something concrete (a related commitment or memory); otherwise null.
- waiting_on: packet commitments with direction "owed_to_me" worth nudging today.
- slipped: packet commitments whose overdue flag is true.
- headline: one or two sentences, the day's shape. If meta.staleSync is true, say the inbox/calendar sync failed and data may be stale.
- Respect instructions.safety and instructions.format from the packet. Precision over completeness — empty sections are fine. Always respond by calling the tool exactly once.`;

function renderPrompt(packet: MorningPacket): string {
  return [
    `Write the morning brief for ${packet.date} (${packet.timezone}) for ${packet.owner.name}.`,
    ...(packet.meta.staleSync
      ? ["NOTE: this morning's pre-sync failed — packet data may be stale; say so in the headline."]
      : []),
    "",
    "CONTEXT PACKET (JSON):",
    JSON.stringify(packet, null, 2),
  ].join("\n");
}

export const morningBriefV1 = {
  task: "cos.morning_brief" as const,
  version: "v1" as const,
  schema: MorningBriefOutput,
  system: SYSTEM,
  renderPrompt,
  contentHash(): string {
    return createHash("sha256")
      .update(SYSTEM)
      .update(JSON.stringify(z.toJSONSchema(MorningBriefOutput)))
      .digest("hex");
  },
};
export type MorningBriefPromptModule = typeof morningBriefV1;
