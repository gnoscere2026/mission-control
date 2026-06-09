import { databaseUrl, loadEnv } from "./env";
import { runMigrations } from "./migrations";

loadEnv();
const url = databaseUrl();
console.log("applying migrations…");
try {
  await runMigrations(url);
  console.log("migrations applied");
} catch (err) {
  console.error("migration failed:", err);
  process.exit(1);
}
