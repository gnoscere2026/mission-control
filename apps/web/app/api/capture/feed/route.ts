import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { commitments, episodes, people } from "@mission-control/db";
import { getDb } from "../../../../src/db";
import { getSession } from "../../../../src/session";

// MC-108 feed: the chat thread + every commitment extracted from it, any
// status — dispositioned candidates keep rendering with their state so the
// thread reflects what happened.
export async function GET() {
  const session = await getSession();
  if (!session.ownerId) return new Response("Unauthorized", { status: 401 });
  const db = getDb();

  const msgs = await db
    .select({
      id: episodes.id,
      occurredAt: episodes.occurredAt,
      payload: episodes.payload,
    })
    .from(episodes)
    .where(and(eq(episodes.ownerId, session.ownerId), eq(episodes.source, "chat")))
    .orderBy(desc(episodes.occurredAt))
    .limit(50);
  msgs.reverse(); // oldest-first for the thread

  const ids = msgs.map((m) => m.id);
  const candidates = ids.length
    ? await db
        .select({
          id: commitments.id,
          episodeId: commitments.sourceEpisodeId,
          description: commitments.description,
          direction: commitments.direction,
          status: commitments.status,
          confidence: commitments.confidence,
          dueDate: commitments.dueDate,
          personName: people.displayName,
          createdAt: commitments.createdAt,
        })
        .from(commitments)
        .leftJoin(people, eq(commitments.counterpartyPersonId, people.id))
        .where(
          and(eq(commitments.ownerId, session.ownerId), inArray(commitments.sourceEpisodeId, ids)),
        )
        .orderBy(asc(commitments.createdAt))
    : [];

  return Response.json({
    messages: msgs.map((m) => ({
      id: m.id,
      text: (m.payload as { text?: string } | null)?.text ?? "",
      occurredAt: m.occurredAt.toISOString(),
    })),
    candidates,
  });
}
