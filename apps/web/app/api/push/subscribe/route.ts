import { getDb } from "../../../../src/db";
import { parseSubscription } from "../../../../src/push";
import { upsertPushSubscription } from "../../../../src/queries";
import { getSession } from "../../../../src/session";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session.ownerId) return new Response("Unauthorized", { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const sub = parseSubscription(body);
  if (!sub) return new Response("Invalid subscription payload", { status: 400 });

  await upsertPushSubscription(getDb(), session.ownerId, sub, req.headers.get("user-agent"));
  return Response.json({ ok: true });
}
