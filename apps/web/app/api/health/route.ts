import { sql } from "drizzle-orm";
import { getDb } from "../../../src/db";

// Public liveness probe (Railway + deploy verification). Cheap DB ping included
// so "green" means the service can actually reach Postgres.
export async function GET() {
  try {
    await getDb().execute(sql`select 1`);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
