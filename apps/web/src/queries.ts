import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  briefs,
  cadenceRuns,
  commitments,
  contextPackets,
  episodes,
  modelCalls,
  pushSubscriptions,
  runSteps,
  users,
  type Db,
} from "@mission-control/db";
import type { SubscriptionPayload } from "./push";

// Every helper takes ownerId — no ownerless query path exists (invariant 1).

export async function findUserByEmail(db: Db, email: string) {
  const [row] = await db.select().from(users).where(eq(users.email, email));
  return row;
}

export async function listBriefs(db: Db, ownerId: string, limit = 50) {
  return db
    .select({
      id: briefs.id,
      kind: briefs.kind,
      dedupeKey: briefs.dedupeKey,
      generatedAt: briefs.generatedAt,
      openedAt: briefs.openedAt,
      pushedAt: briefs.pushedAt,
      emailedAt: briefs.emailedAt,
    })
    .from(briefs)
    .where(eq(briefs.ownerId, ownerId))
    .orderBy(desc(briefs.generatedAt))
    .limit(limit);
}

export async function getBrief(db: Db, ownerId: string, id: string) {
  const [row] = await db
    .select()
    .from(briefs)
    .where(and(eq(briefs.ownerId, ownerId), eq(briefs.id, id)));
  return row;
}

// Re-subscribing the same endpoint refreshes keys and revives a pruned sub.
export async function upsertPushSubscription(
  db: Db,
  ownerId: string,
  sub: SubscriptionPayload,
  userAgent?: string | null,
) {
  await db
    .insert(pushSubscriptions)
    .values({
      ownerId,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      userAgent: userAgent ?? undefined,
    })
    .onConflictDoUpdate({
      target: [pushSubscriptions.ownerId, pushSubscriptions.endpoint],
      set: {
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        failureCount: 0,
        disabledAt: null,
        userAgent: userAgent ?? undefined,
      },
    });
}

export async function listRecentRuns(db: Db, ownerId: string, limit = 50) {
  return db
    .select()
    .from(cadenceRuns)
    .where(eq(cadenceRuns.ownerId, ownerId))
    .orderBy(desc(cadenceRuns.startedAt))
    .limit(limit);
}

// MC-107: "did the Morning Brief go out?" answers from this one query —
// DISTINCT ON (job_name) newest-first.
export async function latestRunPerJob(db: Db, ownerId: string) {
  return db
    .selectDistinctOn([cadenceRuns.jobName])
    .from(cadenceRuns)
    .where(eq(cadenceRuns.ownerId, ownerId))
    .orderBy(asc(cadenceRuns.jobName), desc(cadenceRuns.startedAt));
}

export async function anyLatestRunFailed(db: Db, ownerId: string): Promise<boolean> {
  const latest = await latestRunPerJob(db, ownerId);
  return latest.some((r) => r.status === "failed");
}

export async function getRun(db: Db, ownerId: string, runId: string) {
  const [row] = await db
    .select()
    .from(cadenceRuns)
    .where(and(eq(cadenceRuns.ownerId, ownerId), eq(cadenceRuns.id, runId)));
  return row;
}

export async function listRunSteps(db: Db, runId: string) {
  return db.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.seq));
}

export async function getContextPacket(db: Db, ownerId: string, id: string) {
  const [row] = await db
    .select()
    .from(contextPackets)
    .where(and(eq(contextPackets.ownerId, ownerId), eq(contextPackets.id, id)));
  return row;
}

// "why did you say this?": packet commitments → source excerpt → source episode (MC-203)
export async function listCommitmentSources(db: Db, ownerId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select({
      id: commitments.id,
      description: commitments.description,
      sourceType: commitments.sourceType,
      sourceRef: commitments.sourceRef,
      sourceExcerpt: commitments.sourceExcerpt,
      episodeSummary: episodes.summary,
      episodeOccurredAt: episodes.occurredAt,
    })
    .from(commitments)
    .leftJoin(episodes, eq(commitments.sourceEpisodeId, episodes.id))
    .where(and(eq(commitments.ownerId, ownerId), inArray(commitments.id, ids)));
}

// MC-204: push delivery health — all subscriptions for the owner, newest first.
export async function listPushSubscriptions(db: Db, ownerId: string) {
  return db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.ownerId, ownerId))
    .orderBy(desc(pushSubscriptions.createdAt));
}

// MC-204: today's model spend (Denver-day boundary), rounded to 2 decimal places.
export async function dailyModelSpendUsd(db: Db, ownerId: string): Promise<string> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${modelCalls.costUsd}), 0)::numeric(12,2)`,
    })
    .from(modelCalls)
    .where(
      and(
        eq(modelCalls.ownerId, ownerId),
        sql`${modelCalls.createdAt} >= (date_trunc('day', now() at time zone 'America/Denver') at time zone 'America/Denver')`,
      ),
    );
  return row?.total ?? "0.00";
}
