import { databaseUrl, loadEnv } from "./env";
import { seedUser } from "./seeding";

loadEnv();
const email = process.env.USER_EMAIL;
const displayName = process.env.USER_NAME;
if (!email || !displayName) {
  console.error("seed requires USER_EMAIL and USER_NAME in the environment (see .env.example)");
  process.exit(1);
}
try {
  await seedUser(databaseUrl(), { email, displayName });
  console.log(`seeded user ${email} (idempotent)`);
} catch (err) {
  console.error("seed failed:", err);
  process.exit(1);
}
