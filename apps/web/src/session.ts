import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export interface SessionData {
  ownerId?: string;
}

export const SESSION_COOKIE = "mc_session";

export function sessionOptions(): SessionOptions {
  const password = process.env.SESSION_SECRET;
  if (!password || password.length < 32) {
    throw new Error("SESSION_SECRET must be set and at least 32 characters");
  }
  return {
    cookieName: SESSION_COOKIE,
    password,
    cookieOptions: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  };
}

export async function getSession() {
  return getIronSession<SessionData>(await cookies(), sessionOptions());
}

// Server-side gate: pages/route handlers resolve ownerId from the sealed cookie
// (middleware only does the cheap redirect; this is the actual check).
export async function requireOwnerId(): Promise<string> {
  const session = await getSession();
  if (!session.ownerId) redirect("/login");
  return session.ownerId;
}
