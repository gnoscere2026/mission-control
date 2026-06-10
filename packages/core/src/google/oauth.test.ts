import { describe, expect, it } from "vitest";
import {
  buildGoogleAuthUrl,
  exchangeCode,
  GOOGLE_SCOPES,
  GoogleAuthError,
  refreshAccessToken,
} from "./oauth";

// Invariant 4 (CLAUDE.md): Level-2 autonomy is enforced structurally — a PR
// that widens the Google scopes must fail this test.
describe("GOOGLE_SCOPES", () => {
  it("is exactly gmail.readonly + calendar.readonly", () => {
    expect([...GOOGLE_SCOPES]).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
    ]);
  });
});

describe("buildGoogleAuthUrl", () => {
  it("requests offline access with forced consent and both scopes", () => {
    const url = new URL(
      buildGoogleAuthUrl({ clientId: "cid", redirectUri: "https://app/cb", state: "st4te" }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app/cb");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("st4te");
    expect(url.searchParams.get("scope")).toBe(GOOGLE_SCOPES.join(" "));
  });
});

function fakeFetch(status: number, json: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(json), { status })) as unknown as typeof fetch;
}

describe("exchangeCode", () => {
  it("parses tokens and computes expiry_date", async () => {
    const before = Date.now();
    const tokens = await exchangeCode({
      code: "c",
      clientId: "cid",
      clientSecret: "cs",
      redirectUri: "https://app/cb",
      fetchImpl: fakeFetch(200, {
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        token_type: "Bearer",
        scope: GOOGLE_SCOPES.join(" "),
      }),
    });
    expect(tokens.access_token).toBe("at");
    expect(tokens.refresh_token).toBe("rt");
    expect(tokens.expiry_date).toBeGreaterThanOrEqual(before + 3_590_000);
  });
});

describe("refreshAccessToken", () => {
  it("returns a refreshed token", async () => {
    const tokens = await refreshAccessToken({
      refreshToken: "rt",
      clientId: "cid",
      clientSecret: "cs",
      fetchImpl: fakeFetch(200, { access_token: "at2", expires_in: 3600, token_type: "Bearer" }),
    });
    expect(tokens.access_token).toBe("at2");
    expect(tokens.refresh_token).toBeUndefined();
  });

  it("throws GoogleAuthError with code invalid_grant on revoked/expired consent", async () => {
    const err = await refreshAccessToken({
      refreshToken: "rt",
      clientId: "cid",
      clientSecret: "cs",
      fetchImpl: fakeFetch(400, { error: "invalid_grant", error_description: "Token expired" }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect((err as GoogleAuthError).code).toBe("invalid_grant");
  });
});
