import { describe, expect, test } from "bun:test";
import { buildDashboard, cumulativeRows, dashboardCsv, emptyCounts, groupTrafficRows, plottable, uniqueTraffic } from "./aggregate";
import { combineCoverage, coverageAt, dayBounds, estimateDownloadMinutes, mergeRanges, missingDownloadDays, savedSnapshot, utcWindow } from "./coverage";
import { brailleLineChart, stackedColumns } from "./charts";

describe("saved history coverage", () => {
  test("merges adjacent saves while preserving missing gaps", () => {
    const input = [{ from: "2026-10-07", through: "2026-10-08" }, { from: "2026-10-01", through: "2026-10-02" }, { from: "2026-10-02", through: "2026-10-03" }];
    const ranges = mergeRanges(input);
    expect(ranges).toEqual([{ from: "2026-10-01", through: "2026-10-03" }, { from: "2026-10-07", through: "2026-10-08" }]);
    const status = (day: string) => coverageAt({ ranges }, Date.parse(day), Date.parse(day) + 86_400_000);
    expect(status("2026-10-02")).toBe("complete");
    expect(status("2026-10-04")).toBe("missing");
    expect(input[0]!.from).toBe("2026-10-07");
  });

  test("legacy caches keep the last refreshed day partial", () => {
    const snapshot = savedSnapshot({ coveredFrom: "2026-10-01", fetchedThrough: "2026-10-03", updatedAt: Date.parse("2026-10-03T12:00:00Z") });
    expect(coverageAt(snapshot, Date.parse("2026-10-02"), Date.parse("2026-10-03"))).toBe("complete");
    expect(coverageAt(snapshot, Date.parse("2026-10-03"), Date.parse("2026-10-04"))).toBe("partial");
    expect(coverageAt(snapshot, Date.parse("2026-10-04"), Date.parse("2026-10-05"))).toBe("missing");
    expect(combineCoverage(["complete", "missing"])).toBe("partial");
  });

  test("local day coverage and download boundaries respect DST", () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const spring = dayBounds("2026-03-08", "local");
      const fall = dayBounds("2026-11-01", "local");
      expect((spring.through - spring.from) / 3_600_000).toBe(23);
      expect((fall.through - fall.from) / 3_600_000).toBe(25);
      expect(utcWindow("2026-03-08", "2026-03-08", "local")).toEqual({ from: "2026-03-08", through: "2026-03-09" });
      const snapshot = { ranges: [{ from: "2026-03-08", through: "2026-03-08" }] };
      expect(coverageAt(snapshot, spring.from, spring.through)).toBe("partial");
      snapshot.ranges[0]!.through = "2026-03-09";
      expect(coverageAt(snapshot, spring.from, spring.through)).toBe("complete");
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });

  test("dashboard includes missing accounts, separates comparison coverage, and exports missing days as blanks", () => {
    const data = buildDashboard([{ profile: "prod", events: [], coverage: { ranges: [{ from: "2026-10-01", through: "2026-10-01" }] } },
      { profile: "gone", events: [], coverage: { ranges: [] } }], 2, "utc", { endDay: "2026-10-02" });
    expect(data.coverage.current).toEqual({ complete: 0, partial: 1, missing: 1, total: 2 });
    expect(data.coverage.previous).toEqual({ complete: 0, partial: 0, missing: 2, total: 2 });
    const csv = dashboardCsv(data);
    expect(csv).toContain('"daily","2026-10-02","selection","all lines","","","","","","","missing"');
    expect(csv).toContain('"daily","2026-10-01","selection","all lines","","0","0","0","0","0","partial"');
    const cumulative = cumulativeRows(data.rows);
    expect(cumulative.map((row) => row.coverage)).toEqual(["partial", "partial"]);
  });

  test("download preview skips known days, counts unavailable history and avoids the open day", () => {
    const result = missingDownloadDays({ ranges: [{ from: "2026-10-03", through: "2026-10-03" }] },
      { from: "2026-10-01", through: "2026-10-06" }, "2026-10-02", "2026-10-06");
    expect(result).toEqual({ days: ["2026-10-02", "2026-10-04", "2026-10-05"], unavailable: 1, open: 1 });
    expect(estimateDownloadMinutes(3, 10, 5)).toBe(25);
    expect(estimateDownloadMinutes(0, 10, 5)).toBe(0);
  });

  test("chart gaps stay shaded through compression instead of connecting or becoming zero", () => {
    const line = brailleLineChart([{ values: [2, NaN, 4], color: "cyan" }], 12, 4, 5, { overlapColor: "white", emptyColor: "gray" });
    expect(line.every((row) => row.some((segment) => segment.text.includes("░")))).toBe(true);
    const bars = stackedColumns([1, NaN, 3], [0, NaN, 1], 2, 4, { bottomColor: "cyan", topColor: "purple", emptyColor: "gray" });
    expect(Number.isFinite(bars.max)).toBe(true);
    expect(bars.lines.every((row) => row.some((segment) => segment.text.includes("░")))).toBe(true);
    const series = cumulativeRows([{ date: "2026-10-01", ...emptyCounts(), coverage: "complete" }, { date: "2026-10-02", ...emptyCounts(), coverage: "missing" }, { date: "2026-10-03", ...emptyCounts(), coverage: "complete" }]);
    expect(series.map((row) => row.coverage)).toEqual(["complete", "partial", "partial"]);
  });
});


test("today plots observed traffic while historical and missing-account gaps stay unknown", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  const source = { profile: "prod", events: [{ sid: "SM-today", time: now.getTime() - 1000, kind: "message" as const,
    direction: "in" as const, from: "+15559990000", to: "+15550000001" }],
    coverage: { ranges: [{ from: "2026-10-01", through: "2026-10-22" }],
      live: { from: Date.parse("2026-10-23"), through: now.getTime() } } };
  const data = buildDashboard([source], 7, "utc", { now });
  expect(data.rows.at(-1)).toMatchObject({ msgIn: 1, coverage: "partial", inProgress: true });
  expect(data.coverage.current).toEqual({ complete: 6, partial: 1, missing: 0, total: 7 });
  for (const interval of ["daily", "weekly"] as const) {
    const rows = groupTrafficRows(data.rows, interval);
    expect(rows.every(plottable)).toBe(true);
    expect(cumulativeRows(rows).at(-1)).toMatchObject({ msgIn: 1, coverage: "partial", inProgress: true });
    const unique = uniqueTraffic(data.activity, data.rows, "utc", "in", interval, true, 1);
    expect(unique.rows[0]).toMatchObject({ contacts: 1, coverage: "partial", inProgress: true });
  }
  // Counts stay labelled partial in exports and summaries.
  expect(dashboardCsv(data)).toContain('"1","partial"');
  const missingAccount = buildDashboard([source, { profile: "missing", events: [], coverage: { ranges: [] } }], 7, "utc", { now });
  expect(missingAccount.rows.at(-1)?.inProgress).toBeUndefined();
  expect(plottable(missingAccount.rows.at(-1)!)).toBe(false);
  const gap = { ...source, coverage: { ...source.coverage, ranges: [{ from: "2026-10-22", through: "2026-10-22" }] } };
  const withGap = buildDashboard([gap], 7, "utc", { now });
  expect(withGap.rows.at(-1)?.inProgress).toBe(true);
  expect(plottable(cumulativeRows(withGap.rows).at(-1)!)).toBe(false);
  expect(plottable(groupTrafficRows(withGap.rows, "weekly").at(-1)!)).toBe(false);
  const compressed = uniqueTraffic(withGap.activity, withGap.rows, "utc", "in", "daily", true, 1);
  expect(plottable(compressed.rows[0]!)).toBe(false);
  const historical = buildDashboard([source], 7, "utc", { now: new Date("2026-10-24T12:00:00Z"), endDay: "2026-10-23" });
  expect(historical.rows.at(-1)?.inProgress).toBeUndefined();
});

test("local today plots only when coverage reaches continuously from local midnight", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const now = new Date("2026-10-23T02:00:00Z"); // Still October 22 locally.
    const coverage = { ranges: [{ from: "2026-10-21", through: "2026-10-22" }],
      live: { from: Date.parse("2026-10-23"), through: now.getTime() } };
    const data = buildDashboard([{ events: [], coverage }], 1, "local", { now });
    expect(data.rows[0]).toMatchObject({ date: "2026-10-22", coverage: "partial", inProgress: true });
    const gap = buildDashboard([{ events: [], coverage: { ...coverage, ranges: [] } }], 1, "local", { now });
    expect(gap.rows[0]?.inProgress).toBeUndefined();
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
