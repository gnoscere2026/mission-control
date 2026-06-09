import { and, eq } from "drizzle-orm";
import { briefs, contextPackets, type Db } from "@mission-control/db";

export interface HelloBriefArgs {
  ownerId: string;
  date: string; // YYYY-MM-DD in America/Denver — becomes dedupe key "morning:<date>"
  cadenceRunId?: string;
}

export interface HelloBriefResult {
  created: boolean;
  briefId: string;
}

// Phase-0 placeholder generation (MC-005): real schema, trivial content.
// Idempotency layer 2: the briefs_dedupe_ux unique index — re-running the job
// for the same date converges instead of duplicating (invariant 6).
export async function generateHelloBrief(db: Db, args: HelloBriefArgs): Promise<HelloBriefResult> {
  const dedupeKey = `morning:${args.date}`;

  const findExisting = () =>
    db
      .select({ id: briefs.id })
      .from(briefs)
      .where(and(eq(briefs.ownerId, args.ownerId), eq(briefs.dedupeKey, dedupeKey)));

  const [existing] = await findExisting();
  if (existing) return { created: false, briefId: existing.id };

  const contentJson = { hello: true, date: args.date };
  const [packet] = await db
    .insert(contextPackets)
    .values({ ownerId: args.ownerId, task: "cos.morning_brief", content: contentJson })
    .returning({ id: contextPackets.id });
  if (!packet) throw new Error("context packet insert returned no row");

  const contentMd = [
    `# Good morning — Mission Control`,
    ``,
    `Walking-skeleton brief for **${args.date}**.`,
    ``,
    `The plumbing works end to end: scheduled job → context packet → brief → push + email.`,
    `Real content (your commitments and calendar) arrives in Phase 2.`,
  ].join("\n");

  const [inserted] = await db
    .insert(briefs)
    .values({
      ownerId: args.ownerId,
      kind: "morning",
      dedupeKey,
      contentJson,
      contentMd,
      contextPacketId: packet.id,
      cadenceRunId: args.cadenceRunId,
    })
    .onConflictDoNothing()
    .returning({ id: briefs.id });

  if (!inserted) {
    // lost a race with a concurrent run — converge on the winner's row
    const [winner] = await findExisting();
    if (!winner) throw new Error(`brief conflict but no row found for ${dedupeKey}`);
    return { created: false, briefId: winner.id };
  }
  return { created: true, briefId: inserted.id };
}
