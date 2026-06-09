import { editAndConfirmCommitment, type CommitmentEdits } from "@mission-control/core";
import { getDb } from "../../../../../src/db";
import { getSession } from "../../../../../src/session";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session.ownerId) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;

  let body: { description?: string; direction?: string; dueDate?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const edits: CommitmentEdits = {};
  if (typeof body.description === "string" && body.description.trim()) {
    edits.description = body.description.trim();
  }
  if (body.direction === "owed_by_me" || body.direction === "owed_to_me") {
    edits.direction = body.direction;
  }
  if (body.dueDate !== undefined) {
    if (body.dueDate === "" || body.dueDate === null) edits.dueDate = null;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate)) {
      edits.dueDate = body.dueDate;
      edits.dueDateBasis = "explicit"; // user-stated date
    } else return new Response("dueDate must be YYYY-MM-DD", { status: 400 });
  }

  try {
    await editAndConfirmCommitment(getDb(), { ownerId: session.ownerId, commitmentId: id, edits });
  } catch (err) {
    return new Response((err as Error).message, { status: 409 });
  }
  return Response.json({ ok: true });
}
