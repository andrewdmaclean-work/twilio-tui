import type { TimeZoneMode } from "./aggregate";

export type DayRange = { from: string; through: string };
export type CoverageState = "complete" | "partial" | "missing";
export type CoverageSnapshot = { ranges: DayRange[]; live?: { from: number; through: number } };
export type CoverageSummary = { complete: number; partial: number; missing: number; total: number };
const dayMs = 86_400_000;
const after = (day: string) => new Date(Date.parse(day) + dayMs).toISOString().slice(0, 10);

export function mergeRanges(ranges: DayRange[]): DayRange[] {
  const result: DayRange[] = [];
  for (const range of [...ranges].filter((range) => range.from <= range.through).sort((a, b) => a.from.localeCompare(b.from))) {
    const last = result.at(-1);
    if (last && range.from <= after(last.through)) last.through = last.through > range.through ? last.through : range.through;
    else result.push({ ...range });
  }
  return result;
}

/** Legacy coverage ends at the last refresh instant, rather than the end of that day. */
export function savedSnapshot(entry: { coverageRanges?: DayRange[]; coveredFrom: string | null; fetchedThrough: string | null; updatedAt?: number }): CoverageSnapshot {
  const previousDay = entry.fetchedThrough ? new Date(Date.parse(entry.fetchedThrough) - dayMs).toISOString().slice(0, 10) : null;
  const ranges = entry.coverageRanges ?? (entry.coveredFrom && previousDay && entry.coveredFrom <= previousDay
    ? [{ from: entry.coveredFrom, through: previousDay }] : []);
  const liveStart = entry.fetchedThrough ? Date.parse(entry.fetchedThrough) : 0;
  const live = entry.updatedAt && entry.fetchedThrough && entry.updatedAt >= liveStart
    ? { from: liveStart, through: Math.min(entry.updatedAt, liveStart + dayMs) } : undefined;
  return { ranges: mergeRanges(ranges), live };
}

/** Local midnight boundaries preserve 23/25-hour days across DST. */
export function dayBounds(day: string, timeZone: TimeZoneMode): { from: number; through: number } {
  if (timeZone === "utc") return { from: Date.parse(day), through: Date.parse(day) + dayMs };
  const [year, month, date] = day.split("-").map(Number);
  return { from: new Date(year!, month! - 1, date!).getTime(), through: new Date(year!, month! - 1, date! + 1).getTime() };
}

export function coverageAt(snapshot: CoverageSnapshot, from: number, through: number): CoverageState {
  const intervals = snapshot.ranges.map((range) => ({ from: Date.parse(range.from), through: Date.parse(range.through) + dayMs }));
  if (snapshot.live) intervals.push(snapshot.live);
  intervals.sort((a, b) => a.from - b.from);
  let end = from, overlaps = false;
  for (const interval of intervals) {
    if (interval.through <= from || interval.from >= through) continue;
    overlaps = true;
    if (interval.from > end) break;
    end = Math.max(end, interval.through);
    if (end >= through) return "complete";
  }
  return overlaps ? "partial" : "missing";
}

export function combineCoverage(states: CoverageState[]): CoverageState {
  return states.length && states.every((state) => state === "complete") ? "complete"
    : states.some((state) => state !== "missing") ? "partial" : "missing";
}

export function summarizeCoverage(states: CoverageState[]): CoverageSummary {
  return { complete: states.filter((state) => state === "complete").length,
    partial: states.filter((state) => state === "partial").length,
    missing: states.filter((state) => state === "missing").length, total: states.length };
}

export function utcWindow(start: string, end: string, timeZone: TimeZoneMode): DayRange {
  const from = dayBounds(start, timeZone).from;
  const through = dayBounds(end, timeZone).through;
  return { from: new Date(from).toISOString().slice(0, 10), through: new Date(through - 1).toISOString().slice(0, 10) };
}

/** Only closed UTC days are downloaded; recent sync supplies the open day. */
export function missingDownloadDays(snapshot: CoverageSnapshot, range: DayRange, boundary: string, today: string): { days: string[]; unavailable: number; open: number } {
  const result = { days: [] as string[], unavailable: 0, open: 0 };
  for (let day = range.from; day <= range.through; day = after(day)) {
    if (coverageAt(snapshot, Date.parse(day), Date.parse(day) + dayMs) === "complete") continue;
    if (day >= today) result.open++;
    else if (day < boundary) result.unavailable++;
    else result.days.push(day);
  }
  return result;
}

export function estimateDownloadMinutes(days: number, intervalMinutes: number, waitMinutes = 0): number {
  return days ? Math.max(0, waitMinutes) + Math.max(0, days - 1) * intervalMinutes : 0;
}
