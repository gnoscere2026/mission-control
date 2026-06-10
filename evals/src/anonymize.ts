import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// EVAL-SPEC §1.2: staging → anonymize → HUMAN PASS → fixtures/.
// Deterministic per file (seeded by content hash) so "Dana" is consistently
// "Dana" within a fixture. The output keeps anonymized:false — only the human
// review flips it.
//
//   npm run eval:anonymize -- evals/fixtures/_staging/<file> [--out <file>]

const FAKE_PEOPLE = [
  { name: "Dana Reyes", email: "dana@acme-co.example" },
  { name: "Sam Ortiz", email: "sam@northwind.example" },
  { name: "Priya Kaur", email: "priya@initech.example" },
  { name: "Jordan Lee", email: "jordan@globex.example" },
  { name: "Alex Chen", email: "alex@umbrella.example" },
  { name: "Morgan Diaz", email: "morgan@stark-ind.example" },
];
const FAKE_ORGS = ["Acme Co", "Northwind", "Initech", "Globex", "Umbrella", "Stark Industries"];

function seededIndex(seed: string, salt: string, mod: number): number {
  return parseInt(createHash("sha256").update(seed).update(salt).digest("hex").slice(0, 8), 16) % mod;
}

interface StagedFixture {
  input: { from?: string; to?: string; subject?: string; occurred_at: string; body: string };
  [k: string]: unknown;
}

const file = process.argv[2];
if (!file || file.startsWith("--")) {
  console.error("usage: npm run eval:anonymize -- <staging-file.json> [--out <file>]");
  process.exit(1);
}
const outIdx = process.argv.indexOf("--out");
const outFile = outIdx >= 0 ? process.argv[outIdx + 1]! : undefined;

const raw = JSON.parse(readFileSync(file, "utf8")) as StagedFixture;
const seed = createHash("sha256").update(JSON.stringify(raw)).digest("hex");

// 1. collect real identities from headers
const identities = new Map<string, { name: string; email: string }>();
let personCursor = seededIndex(seed, "person", FAKE_PEOPLE.length);
function fakeFor(realEmail: string): { name: string; email: string } {
  const key = realEmail.toLowerCase();
  if (!identities.has(key)) {
    identities.set(key, FAKE_PEOPLE[personCursor % FAKE_PEOPLE.length]!);
    personCursor++;
  }
  return identities.get(key)!;
}

function swapAddress(header: string | undefined): string | undefined {
  if (!header) return header;
  const m = header.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const email = (m?.[2] ?? header).trim();
  const fake = fakeFor(email);
  return `${fake.name} <${fake.email}>`;
}

// 2. date shift by a multiple of 7 days (weekday-preserving — due-date
// inference depends on weekday math), 7–70 days into the past
const weeks = (seededIndex(seed, "weeks", 10) + 1) * 7;
function shiftDate(iso: string): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() - weeks);
  return d.toISOString();
}

// 3. body: strip signatures + quoted history, swap names/emails
let body = raw.input.body
  .split(/\r?\n/)
  .filter((line) => !line.startsWith(">"))
  .join("\n");
const sigIdx = body.indexOf("\n-- ");
if (sigIdx >= 0) body = body.slice(0, sigIdx);

for (const [real, fake] of identities) {
  body = body.replaceAll(real, fake.email);
}
const orgIdx = seededIndex(seed, "org", FAKE_ORGS.length);
body = body.replace(/\b(Inc\.|LLC|Corp\.)\b/g, FAKE_ORGS[orgIdx]!);

const out = {
  ...raw,
  input: {
    ...raw.input,
    from: swapAddress(raw.input.from),
    to: swapAddress(raw.input.to),
    occurred_at: shiftDate(raw.input.occurred_at),
    body: body.trim(),
  },
  anonymized: false, // the human pass flips this after review (EVAL-SPEC §1.2 step 3)
};

const json = JSON.stringify(out, null, 2) + "\n";
if (outFile) {
  writeFileSync(outFile, json);
  console.error(`wrote ${outFile} — READ IT, confirm nothing identifying survived, then set "anonymized": true`);
} else {
  process.stdout.write(json);
}
