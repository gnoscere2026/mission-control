// All schedules run in America/Denver (CLAUDE.md conventions).
export const SCHEDULE_TZ = "America/Denver";

// YYYY-MM-DD for "today" in Denver — the natural key for daily jobs.
export function dateKeyInDenver(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SCHEDULE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
