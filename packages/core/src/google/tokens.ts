import { and, eq } from "drizzle-orm";
import { googleAccounts, type Db } from "@mission-control/db";
import { sealToken, unsealToken } from "../crypto";
import {
  GoogleAuthError,
  ReauthRequiredError,
  refreshAccessToken,
  type GoogleTokens,
} from "./oauth";
import { markReauthRequired } from "./accounts";

export interface TokenDeps {
  clientId?: string;
  clientSecret?: string;
  sealKey?: string;
  fetchImpl?: typeof fetch;
}

const REFRESH_SKEW_MS = 60_000;

// Returns a usable access token, transparently refreshing (and re-sealing the
// stored token JSON) when it is within a minute of expiry. invalid_grant flips
// the account to reauth_required and throws — callers fail fast and visibly.
export async function getValidAccessToken(
  db: Db,
  ownerId: string,
  accountId: string,
  deps: TokenDeps = {},
): Promise<string> {
  const [account] = await db
    .select()
    .from(googleAccounts)
    .where(and(eq(googleAccounts.ownerId, ownerId), eq(googleAccounts.id, accountId)));
  if (!account) throw new Error(`google account ${accountId} not found for owner`);
  if (account.status === "reauth_required") {
    throw new ReauthRequiredError(account.id, account.email);
  }

  const stored = JSON.parse(await unsealToken(account.encryptedTokens, deps.sealKey)) as GoogleTokens;
  if (stored.expiry_date - Date.now() > REFRESH_SKEW_MS) return stored.access_token;

  if (!stored.refresh_token) {
    await markReauthRequired(db, ownerId, accountId);
    throw new ReauthRequiredError(account.id, account.email);
  }

  const clientId = deps.clientId ?? process.env.GOOGLE_CLIENT_ID;
  const clientSecret = deps.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set");
  }

  try {
    const refreshed = await refreshAccessToken({
      refreshToken: stored.refresh_token,
      clientId,
      clientSecret,
      fetchImpl: deps.fetchImpl,
    });
    const merged: GoogleTokens = {
      ...refreshed,
      refresh_token: refreshed.refresh_token ?? stored.refresh_token,
    };
    await db
      .update(googleAccounts)
      .set({
        encryptedTokens: await sealToken(JSON.stringify(merged), deps.sealKey),
        updatedAt: new Date(),
      })
      .where(and(eq(googleAccounts.ownerId, ownerId), eq(googleAccounts.id, accountId)));
    return merged.access_token;
  } catch (err) {
    if (err instanceof GoogleAuthError && err.code === "invalid_grant") {
      await markReauthRequired(db, ownerId, accountId);
      throw new ReauthRequiredError(account.id, account.email);
    }
    throw err;
  }
}
