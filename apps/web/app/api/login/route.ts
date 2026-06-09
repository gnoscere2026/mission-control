import { verifySecret } from "../../../src/auth";
import { getDb } from "../../../src/db";
import { findUserByEmail } from "../../../src/queries";
import { getSession } from "../../../src/session";

export async function POST(req: Request) {
  const form = await req.formData();
  const secret = String(form.get("secret") ?? "");

  if (!verifySecret(secret, process.env.SESSION_PASSWORD)) {
    // Browser form posts get bounced back to the login page; API callers get 401.
    if (req.headers.get("accept")?.includes("text/html")) {
      return Response.redirect(new URL("/login?error=1", req.url), 303);
    }
    return new Response("Unauthorized", { status: 401 });
  }

  const email = process.env.USER_EMAIL;
  if (!email) return new Response("USER_EMAIL not configured", { status: 500 });
  const user = await findUserByEmail(getDb(), email);
  if (!user) return new Response("owner user not seeded — run npm run db:seed", { status: 500 });

  const session = await getSession();
  session.ownerId = user.id;
  await session.save();
  return Response.redirect(new URL("/", req.url), 303);
}
