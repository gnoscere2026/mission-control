import { appendUserAction, exchangeCode, upsertGoogleAccount } from "@mission-control/core";
import { getDb } from "../../../../src/db";
import { enqueueInitialGoogleSync } from "../../../../src/queues";
import { getSession } from "../../../../src/session";

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

export async function GET(req: Request) {
  const session = await getSession();
  if (!session.ownerId) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) {
    return Response.redirect(`${appUrl()}/settings?google_error=denied`, 302);
  }
  if (!state || state !== session.oauthState) {
    return new Response("OAuth state mismatch", { status: 400 });
  }
  session.oauthState = undefined;
  await session.save();

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return new Response("Google OAuth env vars are not configured", { status: 500 });
  }

  const tokens = await exchangeCode({
    code,
    clientId,
    clientSecret,
    redirectUri: `${appUrl()}/api/google/callback`,
  });

  // The connected account's address comes from the Gmail profile — the gmail
  // scope covers it; no extra userinfo scope needed (invariant 4).
  const profileRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileRes.ok) {
    return new Response(`Gmail profile lookup failed (${profileRes.status})`, { status: 502 });
  }
  const profile = (await profileRes.json()) as { emailAddress: string };

  const db = getDb();
  const accountId = await upsertGoogleAccount(db, {
    ownerId: session.ownerId,
    email: profile.emailAddress,
    tokens,
  });
  await appendUserAction(db, {
    ownerId: session.ownerId,
    action: "google_connected",
    entityType: "google_account",
    entityId: accountId,
    payload: { email: profile.emailAddress },
  });
  await enqueueInitialGoogleSync(accountId);

  return Response.redirect(
    `${appUrl()}/settings?connected=${encodeURIComponent(profile.emailAddress)}`,
    302,
  );
}
