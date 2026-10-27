import { describe, expect, test } from "bun:test";
import { buildDashboard, calendarWindow, cumulativeRows, dashboardCsv, dateWindow, emptyCounts, groupTrafficRows, pick, shiftDay, totalOf, validDay, type TrafficEvent, type TrafficRow } from "./aggregate";
import { accountChoices } from "./data";
import { resample, stackedColumns } from "./charts";

const event = (sid: string, date: string, overrides: Partial<TrafficEvent> = {}): TrafficEvent => ({
  sid, time: Date.parse(date), kind: "message", direction: "in", from: "+15559990000", to: "+15550000001", ...overrides,
});

test("month and quarter to date use calendar boundaries, including leap years and quarter rollover", () => {
  for (const [date, monthStart, quarterStart, monthDays, quarterDays] of [
    ["2026-10-27", "2026-10-01", "2026-10-01", 27, 27],
    ["2026-11-15", "2026-11-01", "2026-10-01", 15, 46],
    ["2026-04-01", "2026-04-01", "2026-04-01", 1, 1],
    ["2027-01-01", "2027-01-01", "2027-01-01", 1, 1],
    ["2024-02-29", "2024-02-01", "2024-01-01", 29, 60],
    ["2026-12-31", "2026-12-01", "2026-10-01", 31, 92],
  ] as const) {
    const now = new Date(`${date}T12:00:00Z`);
    expect(calendarWindow("mtd", "utc", now)).toEqual({ start: monthStart, end: date, period: monthDays });
    expect(calendarWindow("qtd", "utc", now)).toEqual({ start: quarterStart, end: date, period: quarterDays });
  }
  const previous = process.env.TZ;
  process.env.TZ = "America/Vancouver";
  try {
    const now = new Date("2026-04-01T02:00:00Z");
    expect(calendarWindow("qtd", "utc", now)).toEqual({ start: "2026-04-01", end: "2026-04-01", period: 1 });
    expect(calendarWindow("qtd", "local", now)).toEqual({ start: "2026-01-01", end: "2026-03-31", period: 90 });
    expect(calendarWindow("mtd", "local", now)).toEqual({ start: "2026-03-01", end: "2026-03-31", period: 31 });
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

describe("custom time windows and activity", () => {
  test("campaign responses count every received text and original call for one number and account in the selected dates", () => {
    const campaignNumber = "+15550000001";
    const otherNumber = "+15550000002";
    const data = buildDashboard([
      { profile: "campaign", owned: [campaignNumber, otherNumber], events: [
        event("before", "2026-10-01T23:59:59Z"),
        event("first-text", "2026-10-02T00:00:00Z"),
        event("last-text", "2026-10-04T23:59:59Z"),
        event("received-call", "2026-10-03T10:00:00Z", { kind: "call" }),
        event("forwarded-call", "2026-10-03T10:00:01Z", { kind: "call", direction: "out", parent: "received-call", to: "+15551112222" }),
        event("answered-client", "2026-10-03T10:00:02Z", { kind: "call", parent: "received-call", to: "client:agent" }),
        event("reply", "2026-10-03T11:00:00Z", { direction: "out", from: campaignNumber, to: "+15559990000" }),
        event("outgoing-call", "2026-10-03T11:00:00Z", { kind: "call", direction: "out", from: campaignNumber, to: "+15559990000" }),
        event("other-number", "2026-10-03T11:00:00Z", { to: otherNumber }),
        event("excluded-test", "2026-10-03T11:00:00Z", { from: "+15558880000" }),
        event("after", "2026-10-05T00:00:00Z"),
      ] },
      { profile: "another-account", owned: [campaignNumber], events: [event("another-account", "2026-10-03T11:00:00Z")] },
    ], 3, "utc", { endDay: "2026-10-04", excluded: ["5558880000"] });
    const line = data.lines.find((entry) => entry.profile === "campaign" && entry.number === campaignNumber)!;
    expect(pick(line, "in")).toEqual({ messages: 2, calls: 1 });
    expect(totalOf(line, "in")).toBe(3);
    const received = data.activity.filter((entry) => entry.lineKey === line.key && entry.direction === "in");
    expect(received.map((entry) => entry.sid).sort()).toEqual(["first-text", "last-text", "received-call"]);
    expect(received.length).toBe(totalOf(line, "in"));
    const csv = dashboardCsv(data, { direction: "in", lineKey: line.key });
    expect(csv).toContain('"total","2026-10-02..2026-10-04","campaign","+15550000001","","2","0","1","0","3","complete"');
    expect(csv).not.toContain(otherNumber);
    expect(csv).not.toContain('"another-account"');
    // The selected direction changes exports while preserving the same number and window.
    expect(dashboardCsv(data, { direction: "out", lineKey: line.key })).toContain('"total","2026-10-02..2026-10-04","campaign","+15550000001","","0","1","0","2","3","complete"');
  });

  test("validates inclusive dates across leap days and DST", () => {
    expect(dateWindow("2024-02-28", "2024-03-01").period).toBe(3);
    expect(dateWindow("2026-03-07", "2026-03-09").period).toBe(3);
    expect(dateWindow("2026-10-01", "2026-10-01").period).toBe(1);
    expect(validDay("2026-02-30")).toBe(false);
    expect(() => dateWindow("2026-02-30", "2026-03-01")).toThrow();
    expect(() => dateWindow("2026-10-02", "2026-10-01")).toThrow();
    expect(() => dateWindow("2000-01-01", "2026-01-01")).toThrow();
  });

  test("activity and totals share exact boundaries, filters, exclusions and forwarded call attribution", () => {
    const data = buildDashboard([{ profile: "prod", owned: ["+15550000001", "+15550000002"], names: { "+15550000001": "Support" }, events: [
      event("previous", "2026-10-01T23:59:59Z"),
      event("first", "2026-10-02T00:00:00Z"),
      event("last", "2026-10-04T23:59:59Z", { kind: "call" }),
      event("child", "2026-10-04T23:59:59Z", { kind: "call", parent: "last", direction: "out", from: "+15550000001", to: "client:agent" }),
      event("inbound-child", "2026-10-04T23:59:59Z", { kind: "call", parent: "last" }),
      event("excluded", "2026-10-03T10:00:00Z", { from: "+15558880000" }),
      event("other-line", "2026-10-03T11:00:00Z", { to: "+15550000002" }),
      event("after", "2026-10-05T00:00:00Z"),
    ] }], 3, "utc", { endDay: "2026-10-04", filter: "support", excluded: ["5558880000"] });
    expect(data.rows.map((row) => row.date)).toEqual(["2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(data.activity.map((row) => row.sid).sort()).toEqual(["child", "first", "last"]);
    expect(data.activity.every((row) => row.lineKey === data.lines[0]!.key)).toBe(true);
    expect(data.activity.length).toBe(totalOf(data.totals));
    expect(totalOf(data.previous)).toBe(1);
    const sums = cumulativeRows(data.rows);
    expect(sums.map((row) => totalOf(row))).toEqual([1, 1, 3]);
    expect(totalOf(data.rows[2]!)).toBe(2);
    expect(totalOf(sums.at(-1)!)).toBe(totalOf(data.totals));
  });

  test("cumulative chart compression preserves the last total instead of summing totals", () => {
    expect(resample([1, 2, 3, 4], 2, "last")).toEqual([2, 4]);
    const options = { bottomColor: "cyan", topColor: "purple", emptyColor: "black" };
    expect(stackedColumns([1, 2, 3, 4], [0, 1, 1, 1], 1, 5, { ...options, cumulative: true }).max).toBe(5);
    expect(stackedColumns([1, 2, 3, 4], [0, 1, 1, 1], 1, 5, options).max).toBeGreaterThan(5);
  });

  test("weekly counts use Monday–Sunday and only include the selected dates", () => {
    const days: TrafficRow[] = Array.from({ length: 14 }, (_, index) => ({
      date: shiftDay("2026-10-01", index), msgIn: 1, msgOut: 2, callIn: 3, callOut: 4, coverage: "complete",
    }));
    const weeks = groupTrafficRows(days, "weekly");
    expect(weeks).toEqual([
      { date: "2026-10-01", endDate: "2026-10-04", msgIn: 4, msgOut: 8, callIn: 12, callOut: 16, coverage: "complete" },
      { date: "2026-10-05", endDate: "2026-10-11", msgIn: 7, msgOut: 14, callIn: 21, callOut: 28, coverage: "complete" },
      { date: "2026-10-12", endDate: "2026-10-14", msgIn: 3, msgOut: 6, callIn: 9, callOut: 12, coverage: "complete" },
    ]);
    expect(cumulativeRows(weeks).map((row) => [row.endDate, ...Object.values(pick(row, "in"))])).toEqual([
      ["2026-10-04", 4, 12], ["2026-10-11", 11, 33], ["2026-10-14", 14, 42],
    ]);
    expect(groupTrafficRows(days, "daily")).toEqual(days);
    expect(days[0]!.msgIn).toBe(1); // Grouping never changes the daily source or summary totals.
  });

  test("weekly boundaries follow calendar dates across a year and DST", () => {
    for (const [start, length, ranges] of [
      ["2025-12-29", 8, [["2025-12-29", "2026-01-04"], ["2026-01-05", "2026-01-05"]]],
      ["2026-03-07", 3, [["2026-03-07", "2026-03-08"], ["2026-03-09", "2026-03-09"]]],
    ] as const) {
      const rows = Array.from({ length }, (_, index) => ({ date: shiftDay(start, index), ...emptyCounts(), msgIn: 1 }));
      const weeks = groupTrafficRows(rows, "weekly");
      expect(weeks.map((row) => [row.date, row.endDate])).toEqual(ranges.map((range) => [...range]));
      expect(weeks.reduce((sum, row) => sum + row.msgIn, 0)).toBe(length);
    }
    expect(groupTrafficRows([], "weekly")).toEqual([]);
  });

  test("a week with missing data stays unknown and cumulative totals keep the gap", () => {
    const rows: TrafficRow[] = [
      { date: "2026-10-04", ...emptyCounts(), coverage: "missing" },
      { date: "2026-10-05", ...emptyCounts(), msgIn: 3, coverage: "complete" },
      { date: "2026-10-06", ...emptyCounts(), coverage: "missing" },
      { date: "2026-10-12", ...emptyCounts(), msgIn: 2, coverage: "complete" },
    ];
    const weeks = groupTrafficRows(rows, "weekly");
    expect(weeks.map((row) => row.coverage)).toEqual(["missing", "partial", "complete"]);
    expect(cumulativeRows(weeks).map((row) => [row.msgIn, row.coverage])).toEqual([[0, "partial"], [3, "partial"], [5, "partial"]]);
  });

  test("account manager retains disconnected selected and cached accounts without duplicates", () => {
    const choices = accountChoices([{ id: "prod", active: true }], ["prod", "gone"], ["gone", "archive"]);
    expect(choices).toEqual([{ id: "prod", active: true }, { id: "gone", disconnected: true }, { id: "archive", disconnected: true }]);
    expect(accountChoices([], ["gone"], ["gone"])).toEqual([{ id: "gone", disconnected: true }]);
  });
});
