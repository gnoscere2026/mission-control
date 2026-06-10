import { addManualCommitment, findOrCreatePersonByName, resolvePerson } from "@mission-control/core";
import { getDb } from "../../../src/db";
import { getSession } from "../../../src/session";

// Manual ledger add (MC-105): skips candidate state. Form post from /commitments.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session.ownerId) return new Response("Unauthorized", { status: 401 });

  const form = await req.formData();
  const description = String(form.get("description") ?? "").trim();
  const direction = String(form.get("direction") ?? "");
  const dueDate = String(form.get("dueDate") ?? "").trim();
  const counterparty = String(form.get("counterparty") ?? "").trim();

  if (!description) return new Response("description required", { status: 400 });
  if (direction !== "owed_by_me" && direction !== "owed_to_me") {
    return new Response("direction must be owed_by_me or owed_to_me", { status: 400 });
  }
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return new Response("dueDate must be YYYY-MM-DD", { status: 400 });
  }

  const db = getDb();
  let counterpartyPersonId: string | null = null;
  if (counterparty) {
    // name or email — email gets proper person resolution, bare name matches/creates
    counterpartyPersonId = counterparty.includes("@")
      ? await resolvePerson(db, session.ownerId, { email: counterparty }, new Date())
      : await findOrCreatePersonByName(db, session.ownerId, counterparty);
  }

  await addManualCommitment(db, {
    ownerId: session.ownerId,
    direction,
    description,
    dueDate: dueDate || null,
    counterpartyPersonId,
  });

  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return Response.redirect(`${base}/commitments`, 303);
}
