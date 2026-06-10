import { and, eq } from "drizzle-orm";
import { briefs, type Db } from "@mission-control/db";
import { complete, embed } from "@mission-control/llm";
import { assembleContextPacket } from "../context/packet";
import { ACTIVE_MORNING_BRIEF } from "./active";
import { renderMorningBriefMd } from "./render-morning";

export interface MorningBriefArgs {
  ownerId: string;
  date: string; // YYYY-MM-DD Denver → dedupe key "morning:<date>"
  cadenceRunId?: string;
  staleSync?: boolean;
  now?: Date;
  completeImpl?: typeof complete;
  embedImpl?: typeof embed;
}

export interface MorningBriefResult {
  created: boolean;
  briefId: string;
}

// MC-203: replaces generateHelloBrief on the morning_brief job. Same two-layer
// idempotency as hello (dedupe check → unique-index converge). Generation failure
// throws BEFORE any brief insert: failed run, no brief row, no notify.
export async function generateMorningBrief(db: Db, args: MorningBriefArgs): Promise<MorningBriefResult> {
  const dedupeKey = `morning:${args.date}`;
  const findExisting = () =>
    db
      .select({ id: briefs.id })
      .from(briefs)
      .where(and(eq(briefs.ownerId, args.ownerId), eq(briefs.dedupeKey, dedupeKey)));

  const [existing] = await findExisting();
  if (existing) return { created: false, briefId: existing.id };

  const { packetId, packet } = await assembleContextPacket(db, {
    ownerId: args.ownerId,
    date: args.date,
    now: args.now,
    staleSync: args.staleSync,
    runId: args.cadenceRunId ?? null,
    embedImpl: args.embedImpl,
  });

  const completeImpl = args.completeImpl ?? complete;
  const { data } = await completeImpl({
    db,
    ownerId: args.ownerId,
    task: ACTIVE_MORNING_BRIEF.task,
    schema: ACTIVE_MORNING_BRIEF.schema,
    system: ACTIVE_MORNING_BRIEF.system,
    prompt: ACTIVE_MORNING_BRIEF.renderPrompt(packet),
    maxTokens: 8192,
    runId: args.cadenceRunId ?? null,
    promptVersion: ACTIVE_MORNING_BRIEF.version,
    dataCategories: ["email", "calendar", "memory", "commitment"],
  });

  const contentMd = renderMorningBriefMd(data, args.date);
  const [inserted] = await db
    .insert(briefs)
    .values({
      ownerId: args.ownerId,
      kind: "morning",
      dedupeKey,
      contentJson: data,
      contentMd,
      contextPacketId: packetId,
      cadenceRunId: args.cadenceRunId,
    })
    .onConflictDoNothing()
    .returning({ id: briefs.id });

  if (!inserted) {
    const [winner] = await findExisting();
    if (!winner) throw new Error(`brief conflict but no row found for ${dedupeKey}`);
    return { created: false, briefId: winner.id };
  }
  return { created: true, briefId: inserted.id };
}
