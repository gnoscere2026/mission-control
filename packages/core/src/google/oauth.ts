// Google OAuth, read-only scopes only (CLAUDE.md invariant 4). Plain fetch
// against Google's endpoints — no Google SDK; everything here is injectable
// for tests via fetchImpl.

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

export class GoogleAuthError extends Error {
  constructor(
    message: string,
    public code: string,
    public status?: number,
  ) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

// R2 (RISK-REGISTER): the OAuth app stays in Testing status, so refresh tokens
// expire ~weekly. invalid_grant is core scope: flag the account, fail fast.
export class ReauthRequiredError extends GoogleAuthError {
  constructor(
    public accountId: string,
    public email: string,
  ) {
    super(`Google account ${email} requires re-consent (invalid_grant)`, "invalid_grant");
    this.name = "ReauthRequiredError";
  }
}

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date: number; // epoch ms
  token_type: string;
  scope: string;
}

export function buildGoogleAuthUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const p = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: args.state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

type Fetch = typeof fetch;

async function tokenRequest(body: URLSearchParams, fetchImpl: Fetch): Promise<GoogleTokens> {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const code = String(json.error ?? "token_error");
    throw new GoogleAuthError(
      `google token endpoint ${res.status}: ${code} ${String(json.error_description ?? "")}`.trim(),
      code,
      res.status,
    );
  }
  return {
    access_token: String(json.access_token),
    refresh_token: json.refresh_token ? String(json.refresh_token) : undefined,
    expiry_date: Date.now() + Number(json.expires_in ?? 0) * 1000,
    token_type: String(json.token_type ?? "Bearer"),
    scope: String(json.scope ?? ""),
  };
}

export async function exchangeCode(args: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: Fetch;
}): Promise<GoogleTokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      client_id: args.clientId,
      client_secret: args.clientSecret,
      redirect_uri: args.redirectUri,
    }),
    args.fetchImpl ?? fetch,
  );
}

export async function refreshAccessToken(args: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: Fetch;
}): Promise<GoogleTokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
      client_id: args.clientId,
      client_secret: args.clientSecret,
    }),
    args.fetchImpl ?? fetch,
  );
}
