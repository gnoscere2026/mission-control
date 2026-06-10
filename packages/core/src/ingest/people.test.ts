import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, people, users, type Db } from "@mission-control/db";
import { parseAddress, resolvePerson } from "./people";

const url =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control";

let db: Db;
let ownerId: string;

beforeAll(async () => {
  ({ db } = createDb(url));
  const email = "people-test@example.com";
  await db.insert(users).values({ email, displayName: "People Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, email));
  ownerId = u!.id;
  await db.delete(people).where(eq(people.ownerId, ownerId));
});

describe("parseAddress", () => {
  it("parses Name <email>", () => {
    expect(parseAddress("Dana Reyes <dana@acme.example>")).toEqual({
      email: "dana@acme.example",
      name: "Dana Reyes",
    });
  });
  it("parses quoted names", () => {
    expect(parseAddress('"Reyes, Dana" <Dana@Acme.example>')).toEqual({
      email: "dana@acme.example",
      name: "Reyes, Dana",
    });
  });
  it("parses bare email", () => {
    expect(parseAddress("dana@acme.example")).toEqual({ email: "dana@acme.example" });
  });
});

describe("resolvePerson", () => {
  it("creates on first sight, matches on second, bumps last_contact_at", async () => {
    const t1 = new Date("2026-06-01T10:00:00Z");
    const t2 = new Date("2026-06-05T10:00:00Z");
    const id1 = await resolvePerson(db, ownerId, { email: "sam@x.example", name: "Sam Ortiz" }, t1);
    const id2 = await resolvePerson(db, ownerId, { email: "sam@x.example" }, t2);
    expect(id2).toBe(id1);
    const [row] = await db.select().from(people).where(eq(people.id, id1));
    expect(row!.displayName).toBe("Sam Ortiz");
    expect(row!.lastContactAt!.toISOString()).toBe(t2.toISOString());
  });

  it("does not move last_contact_at backwards", async () => {
    const t1 = new Date("2026-06-05T10:00:00Z");
    const t0 = new Date("2026-05-01T10:00:00Z");
    const id = await resolvePerson(db, ownerId, { email: "old@x.example" }, t1);
    await resolvePerson(db, ownerId, { email: "old@x.example" }, t0);
    const [row] = await db.select().from(people).where(eq(people.id, id));
    expect(row!.lastContactAt!.toISOString()).toBe(t1.toISOString());
  });

  it("backfills a real name over a localpart-derived one", async () => {
    const t = new Date("2026-06-01T10:00:00Z");
    const id = await resolvePerson(db, ownerId, { email: "p.kaur@x.example" }, t);
    let [row] = await db.select().from(people).where(eq(people.id, id));
    expect(row!.displayName).toBe("p.kaur");
    await resolvePerson(db, ownerId, { email: "p.kaur@x.example", name: "Priya Kaur" }, t);
    [row] = await db.select().from(people).where(eq(people.id, id));
    expect(row!.displayName).toBe("Priya Kaur");
  });

  it("matches case-insensitively on email", async () => {
    const t = new Date("2026-06-01T10:00:00Z");
    const id1 = await resolvePerson(db, ownerId, { email: "Mixed@Case.example" }, t);
    const id2 = await resolvePerson(db, ownerId, { email: "mixed@case.example" }, t);
    expect(id2).toBe(id1);
  });
});
