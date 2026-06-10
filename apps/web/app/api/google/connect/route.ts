import { buildGoogleAuthUrl } from "@mission-control/core";
import { getSession } from "../../../../src/session";

function redirectUri(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${base}/api/google/callback`;
}

export async function GET() {
  const session = await getSession();
  if (!session.ownerId) return new Response("Unauthorized", { status: 401 });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return new Response("GOOGLE_CLIENT_ID is not configured — see docs/DEPLOY.md", { status: 500 });
  }

  const state = crypto.randomUUID();
  session.oauthState = state;
  await session.save();

  return Response.redirect(
    buildGoogleAuthUrl({ clientId, redirectUri: redirectUri(), state }),
    302,
  );
}
