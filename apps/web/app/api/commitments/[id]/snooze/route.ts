import { snoozeCommitment } from "@mission-control/core";
import { getDb } from "../../../../../src/db";
import { getSession } from "../../../../../src/session";

const DEFAULT_SNOOZE_DAYS = 7;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session.ownerId) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;

  let days = DEFAULT_SNOOZE_DAYS;
  try {
    const body = (await req.json()) as { days?: number };
    if (typeof body.days === "number" && body.days > 0 && body.days <= 365) days = body.days;
  } catch {
    // empty body → default snooze
  }

  try {
    await snoozeCommitment(getDb(), {
      ownerId: session.ownerId,
      commitmentId: id,
      until: new Date(Date.now() + days * 86_400_000),
    });
  } catch (err) {
    return new Response((err as Error).message, { status: 409 });
  }
  return Response.json({ ok: true });
}
