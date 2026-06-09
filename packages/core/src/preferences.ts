import { and, eq } from "drizzle-orm";
import { userPreferences, type Db } from "@mission-control/db";
import { SCHEDULE_TZ } from "./time";

export async function getPreference<T>(db: Db, ownerId: string, key: string): Promise<T | undefined> {
  const [row] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.ownerId, ownerId), eq(userPreferences.key, key)));
  return row?.value as T | undefined;
}

export async function setPreference(db: Db, ownerId: string, key: string, value: unknown) {
  await db
    .insert(userPreferences)
    .values({ ownerId, key, value })
    .onConflictDoUpdate({
      target: [userPreferences.ownerId, userPreferences.key],
      set: { value, updatedAt: new Date() },
    });
}

// Ingest cadence window (BUILD-PLAN session 1.1): every 15 min, working hours.
export interface WorkingHours {
  startHour: number; // inclusive, America/Denver
  endHour: number; // exclusive
}
export const DEFAULT_WORKING_HOURS: WorkingHours = { startHour: 7, endHour: 19 };

export async function getWorkingHours(db: Db, ownerId: string): Promise<WorkingHours> {
  return (await getPreference<WorkingHours>(db, ownerId, "working_hours")) ?? DEFAULT_WORKING_HOURS;
}

export function hourInDenver(now: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: SCHEDULE_TZ,
      hour: "numeric",
      hour12: false,
    }).format(now),
  );
}

export function isWithinWorkingHours(hours: WorkingHours, now: Date = new Date()): boolean {
  const h = hourInDenver(now);
  return h >= hours.startHour && h < hours.endHour;
}
