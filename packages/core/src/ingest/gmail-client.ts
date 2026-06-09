// Fetch-based Gmail REST client (ARCHITECTURE §2.3) — no Google SDK. Read-only
// endpoints only; the access token comes from a provider callback so token
// refresh stays in core/google.

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: number; // epoch ms
  from: string;
  to: string;
  subject: string;
  snippet: string;
  bodyExcerpt: string; // first text/plain part, capped
}

export interface GmailHistoryPage {
  historyId: string;
  messageIds: string[];
  nextPageToken?: string;
}

export class GmailHistoryGoneError extends Error {}
export class GmailApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export interface GmailClient {
  getProfile(): Promise<{ emailAddress: string; historyId: string }>;
  listHistory(startHistoryId: string, pageToken?: string): Promise<GmailHistoryPage>;
  listMessageIds(q: string, pageToken?: string): Promise<{ ids: string[]; nextPageToken?: string }>;
  getMessage(id: string): Promise<GmailMessage>;
}

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
export const BODY_EXCERPT_MAX = 2000;

interface GmailPayloadPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPayloadPart[];
  headers?: { name: string; value: string }[];
}

function findPlainText(part: GmailPayloadPart | undefined): string | undefined {
  if (!part) return undefined;
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const p of part.parts ?? []) {
    const found = findPlainText(p);
    if (found) return found;
  }
  return undefined;
}

function header(payload: GmailPayloadPart | undefined, name: string): string {
  return payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export function createGmailClient(
  getAccessToken: () => Promise<string>,
  fetchImpl: typeof fetch = fetch,
): GmailClient {
  async function call(path: string): Promise<Record<string, unknown>> {
    const token = await getAccessToken();
    const res = await fetchImpl(`${BASE}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 404) throw new GmailHistoryGoneError(`gmail 404 on ${path}`);
    if (!res.ok) throw new GmailApiError(`gmail ${res.status} on ${path}`, res.status);
    return (await res.json()) as Record<string, unknown>;
  }

  return {
    async getProfile() {
      const json = await call("/profile");
      return { emailAddress: String(json.emailAddress), historyId: String(json.historyId) };
    },

    async listHistory(startHistoryId, pageToken) {
      const p = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded" });
      if (pageToken) p.set("pageToken", pageToken);
      const json = (await call(`/history?${p}`)) as {
        historyId?: string;
        nextPageToken?: string;
        history?: { messagesAdded?: { message?: { id?: string } }[] }[];
      };
      const ids = (json.history ?? [])
        .flatMap((h) => h.messagesAdded ?? [])
        .map((m) => m.message?.id)
        .filter((id): id is string => Boolean(id));
      return {
        historyId: String(json.historyId ?? startHistoryId),
        messageIds: [...new Set(ids)],
        nextPageToken: json.nextPageToken,
      };
    },

    async listMessageIds(q, pageToken) {
      const p = new URLSearchParams({ q, maxResults: "100" });
      if (pageToken) p.set("pageToken", pageToken);
      const json = (await call(`/messages?${p}`)) as {
        messages?: { id: string }[];
        nextPageToken?: string;
      };
      return { ids: (json.messages ?? []).map((m) => m.id), nextPageToken: json.nextPageToken };
    },

    async getMessage(id) {
      const json = (await call(`/messages/${id}?format=full`)) as {
        id: string;
        threadId: string;
        internalDate?: string;
        snippet?: string;
        payload?: GmailPayloadPart;
      };
      const body = findPlainText(json.payload) ?? json.snippet ?? "";
      return {
        id: json.id,
        threadId: json.threadId,
        internalDate: Number(json.internalDate ?? Date.now()),
        from: header(json.payload, "From"),
        to: header(json.payload, "To"),
        subject: header(json.payload, "Subject"),
        snippet: json.snippet ?? "",
        bodyExcerpt: body.slice(0, BODY_EXCERPT_MAX),
      };
    },
  };
}
