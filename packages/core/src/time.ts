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

// YYYY-MM-DDTHH-mm in Denver, floored to the quarter hour — the natural key
// for 15-minute ingest jobs ("-" separators: BullMQ rejects ":" in jobIds).
export function quarterHourStampInDenver(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SCHEDULE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const minute = String(Math.floor(Number(get("minute")) / 15) * 15).padStart(2, "0");
  // Intl renders midnight as "24" with hour12:false in some runtimes; normalize.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}-${minute}`;
}
