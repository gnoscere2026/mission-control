import { appendUserAction, deleteGoogleAccount, getGoogleAccount } from "@mission-control/core";
import { getDb } from "../../../../src/db";
import { getSession } from "../../../../src/session";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session.ownerId) return new Response("Unauthorized", { status: 401 });

  const form = await req.formData();
  const accountId = String(form.get("accountId") ?? "");
  if (!accountId) return new Response("accountId required", { status: 400 });

  const db = getDb();
  const account = await getGoogleAccount(db, session.ownerId, accountId);
  if (!account) return new Response("Not found", { status: 404 });

  await deleteGoogleAccount(db, session.ownerId, accountId);
  await appendUserAction(db, {
    ownerId: session.ownerId,
    action: "google_disconnected",
    entityType: "google_account",
    entityId: accountId,
    payload: { email: account.email },
  });

  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return Response.redirect(`${base}/settings`, 303);
}
