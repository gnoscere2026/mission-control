import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

// Fixture contract — EVAL-SPEC §1.1 exactly, plus the optional alias table the
// matcher uses for name↔email counterparty resolution.

export const ExpectedCommitment = z.object({
  direction: z.enum(["owed_by_me", "owed_to_me"]),
  counterparty: z.string(), // email for mail fixtures, display name for chat
  description_gist: z.string(),
  due: z
    .object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      basis: z.enum(["explicit", "inferred"]),
    })
    .nullable(),
});

export const Fixture = z.object({
  id: z.string(),
  source_type: z.enum(["email", "calendar", "manual", "chat"]),
  input: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    subject: z.string().optional(),
    occurred_at: z.string(),
    body: z.string(),
  }),
  expected: z.array(ExpectedCommitment),
  notes: z.string().optional(),
  anonymized: z.boolean(),
  aliases: z.record(z.string(), z.array(z.string())).optional(),
});

export type FixtureT = z.infer<typeof Fixture>;
export type ExpectedCommitmentT = z.infer<typeof ExpectedCommitment>;

export const FIXTURES_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
  "fixtures",
  "extraction",
);

export function loadFixtures(dir = FIXTURES_DIR, filter?: string): FixtureT[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => (filter ? f.includes(filter) : true))
    .sort();
  if (files.length === 0) throw new Error(`no fixtures found in ${dir}`);

  return files.map((file) => {
    const raw: unknown = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    const parsed = Fixture.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`fixture ${file} is invalid: ${JSON.stringify(parsed.error.issues)}`);
    }
    // EVAL-SPEC §1.2: the runner hard-fails on any fixture not through the
    // anonymization workflow — real content never reaches a model run from here.
    if (parsed.data.anonymized !== true) {
      throw new Error(`fixture ${file} has anonymized != true — refusing to run`);
    }
    return parsed.data;
  });
}

// Stable identity for "which fixture set produced these numbers".
export function fixtureSetHash(fixtures: FixtureT[]): string {
  const h = createHash("sha256");
  for (const f of [...fixtures].sort((a, b) => a.id.localeCompare(b.id))) {
    h.update(f.id).update(JSON.stringify(f));
  }
  return h.digest("hex");
}
