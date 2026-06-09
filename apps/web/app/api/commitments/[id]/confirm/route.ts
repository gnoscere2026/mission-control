import { confirmCommitment } from "@mission-control/core";
import { getDb } from "../../../../../src/db";
import { getSession } from "../../../../../src/session";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session.ownerId) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  try {
    await confirmCommitment(getDb(), { ownerId: session.ownerId, commitmentId: id });
  } catch (err) {
    return new Response((err as Error).message, { status: 409 });
  }
  return Response.json({ ok: true });
}
