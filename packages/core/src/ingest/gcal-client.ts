// Fetch-based Google Calendar REST client (read-only). Incremental sync via
// syncToken; 410 GONE → GcalSyncTokenExpiredError → caller resyncs from timeMin.

export interface GcalEvent {
  id: string;
  status: string; // confirmed | tentative | cancelled
  updated: string; // RFC3339
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email: string; displayName?: string; self?: boolean }[];
  raw: unknown;
}

export interface GcalEventsPage {
  items: GcalEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export class GcalSyncTokenExpiredError extends Error {}
export class GcalApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export interface GcalClient {
  listEvents(args: {
    syncToken?: string;
    timeMin?: string;
    pageToken?: string;
  }): Promise<GcalEventsPage>;
}

const BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export function createGcalClient(
  getAccessToken: () => Promise<string>,
  fetchImpl: typeof fetch = fetch,
): GcalClient {
  return {
    async listEvents(args) {
      const p = new URLSearchParams({ singleEvents: "true", maxResults: "250" });
      if (args.syncToken) p.set("syncToken", args.syncToken);
      else if (args.timeMin) p.set("timeMin", args.timeMin);
      if (args.pageToken) p.set("pageToken", args.pageToken);

      const token = await getAccessToken();
      const res = await fetchImpl(`${BASE}?${p}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 410) throw new GcalSyncTokenExpiredError("gcal sync token expired");
      if (!res.ok) throw new GcalApiError(`gcal ${res.status}`, res.status);
      const json = (await res.json()) as {
        items?: Record<string, unknown>[];
        nextPageToken?: string;
        nextSyncToken?: string;
      };
      return {
        items: (json.items ?? []).map((item) => ({
          id: String(item.id),
          status: String(item.status ?? "confirmed"),
          updated: String(item.updated ?? ""),
          summary: item.summary ? String(item.summary) : undefined,
          start: item.start as GcalEvent["start"],
          end: item.end as GcalEvent["end"],
          attendees: item.attendees as GcalEvent["attendees"],
          raw: item,
        })),
        nextPageToken: json.nextPageToken,
        nextSyncToken: json.nextSyncToken,
      };
    },
  };
}
