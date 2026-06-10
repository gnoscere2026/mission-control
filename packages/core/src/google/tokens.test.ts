import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import sodium from "libsodium-wrappers";
import { createDb, googleAccounts, users, type Db } from "@mission-control/db";
import { unsealToken } from "../crypto";
import { GOOGLE_SCOPES, ReauthRequiredError, type GoogleTokens } from "./oauth";
import { getValidAccessToken } from "./tokens";
import { upsertGoogleAccount } from "./accounts";

const url =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control";

let db: Db;
let ownerId: string;
let sealKey: string;

beforeAll(async () => {
  ({ db } = createDb(url));
  await sodium.ready;
  sealKey = sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL);
  const email = "google-tokens-test@example.com";
  await db.insert(users).values({ email, displayName: "Tokens Test" }).onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, email));
  ownerId = u!.id;
});

function tokens(expiryMs: number): GoogleTokens {
  return {
    access_token: "fresh-at",
    refresh_token: "rt",
    expiry_date: expiryMs,
    token_type: "Bearer",
    scope: GOOGLE_SCOPES.join(" "),
  };
}

async function seedAccount(email: string, t: GoogleTokens): Promise<string> {
  const id = await upsertGoogleAccount(db, { ownerId, email, tokens: t, sealKey });
  return id;
}

const deps = { clientId: "cid", clientSecret: "cs", sealKey: undefined as string | undefined };

describe("getValidAccessToken", () => {
  it("returns the stored token while it is fresh (no refresh call)", async () => {
    const accountId = await seedAccount("fresh@example.com", tokens(Date.now() + 3_600_000));
    const fetchImpl = (async () => {
      throw new Error("must not call the token endpoint for a fresh token");
    }) as unknown as typeof fetch;
    const at = await getValidAccessToken(db, ownerId, accountId, { ...deps, sealKey, fetchImpl });
    expect(at).toBe("fresh-at");
  });

  it("refreshes and re-seals when expired", async () => {
    const accountId = await seedAccount("stale@example.com", tokens(Date.now() - 1000));
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ access_token: "new-at", expires_in: 3600, token_type: "Bearer" }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const at = await getValidAccessToken(db, ownerId, accountId, { ...deps, sealKey, fetchImpl });
    expect(at).toBe("new-at");

    const [row] = await db.select().from(googleAccounts).where(eq(googleAccounts.id, accountId));
    const stored = JSON.parse(await unsealToken(row!.encryptedTokens, sealKey)) as GoogleTokens;
    expect(stored.access_token).toBe("new-at");
    // the refresh token survives a response that omits it
    expect(stored.refresh_token).toBe("rt");
  });

  it("flags reauth_required and throws on invalid_grant", async () => {
    const accountId = await seedAccount("revoked@example.com", tokens(Date.now() - 1000));
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as unknown as typeof fetch;
    await expect(
      getValidAccessToken(db, ownerId, accountId, { ...deps, sealKey, fetchImpl }),
    ).rejects.toBeInstanceOf(ReauthRequiredError);

    const [row] = await db.select().from(googleAccounts).where(eq(googleAccounts.id, accountId));
    expect(row!.status).toBe("reauth_required");
  });

  it("re-consent via upsert restores active status without touching cursors", async () => {
    const accountId = await seedAccount("reconsent@example.com", tokens(Date.now() - 1000));
    await db
      .update(googleAccounts)
      .set({ status: "reauth_required", gmailHistoryId: "h123" })
      .where(eq(googleAccounts.id, accountId));

    const again = await upsertGoogleAccount(db, {
      ownerId,
      email: "reconsent@example.com",
      tokens: tokens(Date.now() + 3_600_000),
      sealKey,
    });
    expect(again).toBe(accountId);
    const [row] = await db.select().from(googleAccounts).where(eq(googleAccounts.id, accountId));
    expect(row!.status).toBe("active");
    expect(row!.gmailHistoryId).toBe("h123"); // re-auth must NOT trigger a fresh backfill
  });

  it("stores ciphertext, not plaintext tokens", async () => {
    const accountId = await seedAccount("cipher@example.com", tokens(Date.now() + 3_600_000));
    const [row] = await db.select().from(googleAccounts).where(eq(googleAccounts.id, accountId));
    expect(row!.encryptedTokens).not.toContain("fresh-at");
    expect(row!.encryptedTokens).not.toContain("rt");
  });
});
