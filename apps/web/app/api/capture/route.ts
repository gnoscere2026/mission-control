import { appendUserAction } from "@mission-control/core";
import { episodes } from "@mission-control/db";
import { getDb } from "../../../src/db";
import { enqueueExtraction } from "../../../src/queues";
import { getSession } from "../../../src/session";

const MAX_LEN = 4000;

// MC-108: each sent message IS the quick-capture integration — an episodes row
// (source 'chat') plus the standard extraction job. Web enqueues, worker
// processes (ARCHITECTURE §4). No generation calls here.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session.ownerId) return new Response("Unauthorized", { status: 401 });

  let body: { text?: string };
  try {
    body = (await req.json()) as { text?: string };
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const text = (body.text ?? "").trim();
  if (!text) return new Response("text required", { status: 400 });
  if (text.length > MAX_LEN) return new Response(`text exceeds ${MAX_LEN} chars`, { status: 400 });

  const db = getDb();
  const [ep] = await db
    .insert(episodes)
    .values({
      ownerId: session.ownerId,
      occurredAt: new Date(),
      type: "chat_message",
      source: "chat",
      summary: text.slice(0, 140),
      payload: { text },
    })
    .returning({ id: episodes.id });
  if (!ep) return new Response("episode insert failed", { status: 500 });

  await appendUserAction(db, {
    ownerId: session.ownerId,
    action: "capture_submitted",
    entityType: "episode",
    entityId: ep.id,
  });
  await enqueueExtraction(ep.id);

  return Response.json({ episodeId: ep.id });
}
