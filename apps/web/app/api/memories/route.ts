import { createMemory } from "@mission-control/core";
import { getDb } from "../../../src/db";
import { getSession } from "../../../src/session";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session.ownerId) return new Response("unauthorized", { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { content?: string; sourceEpisodeId?: string };
  const content = body.content?.trim();
  if (!content) return new Response("content required", { status: 400 });
  // same cap as capture: this feeds a paid embed call
  if (content.length > 4000) return new Response("content too long", { status: 400 });

  const { memoryId } = await createMemory(getDb(), {
    ownerId: session.ownerId,
    content,
    source: "manual_pin",
    sourceEpisodeId: body.sourceEpisodeId ?? null,
  });
  return Response.json({ memoryId });
}
