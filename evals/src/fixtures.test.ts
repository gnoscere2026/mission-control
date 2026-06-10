import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureSetHash, loadFixtures } from "./fixtures";
import { guardDatabaseUrl } from "./runner";

describe("loadFixtures", () => {
  it("loads the committed fixture set: ≥25 fixtures, ≥1/3 hard negatives", () => {
    const fixtures = loadFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(25);
    const negatives = fixtures.filter((f) => f.expected.length === 0).length;
    expect(negatives / fixtures.length).toBeGreaterThanOrEqual(1 / 3 - 0.01);
    // every committed fixture passed the anonymization workflow
    expect(fixtures.every((f) => f.anonymized)).toBe(true);
  });

  it("refuses a fixture with anonymized != true", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fx-"));
    writeFileSync(
      path.join(dir, "fx-bad.json"),
      JSON.stringify({
        id: "fx-bad",
        source_type: "email",
        input: { occurred_at: "2026-05-12T10:00:00-06:00", body: "x" },
        expected: [],
        anonymized: false,
      }),
    );
    expect(() => loadFixtures(dir)).toThrow(/anonymized/);
  });

  it("fixtureSetHash is stable and order-independent", () => {
    const fixtures = loadFixtures();
    const reversed = [...fixtures].reverse();
    expect(fixtureSetHash(fixtures)).toBe(fixtureSetHash(reversed));
  });
});

describe("guardDatabaseUrl", () => {
  it("allows localhost", () => {
    expect(() => guardDatabaseUrl("postgres://u:p@localhost:5433/mc")).not.toThrow();
    expect(() => guardDatabaseUrl("postgres://u:p@127.0.0.1:5432/mc")).not.toThrow();
  });
  it("refuses anything that could be production", () => {
    expect(() => guardDatabaseUrl("postgres://u:p@roundhouse.proxy.rlwy.net:5432/railway")).toThrow(
      /refuses non-local/,
    );
  });
});
