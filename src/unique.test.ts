import { describe, expect, test } from "bun:test";
import { buildDashboard, dashboardCsv, emptyCounts, lineKey, shiftDay, totalOf, uniqueTraffic, type ActivityEvent, type TrafficRow } from "./aggregate";

const number = "+15550000001";
const alice = "+15559990000";
const bob = "+15558880000";
const carol = "+15557770000";
const days: TrafficRow[] = Array.from({ length: 8 }, (_, index) => ({ date: shiftDay("2026-10-04", index), ...emptyCounts(), coverage: "complete" }));
function event(sid: string, date: string, from = alice, kind: "message" | "call" = "message", overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return { sid, time: Date.parse(`${date}T12:00:00Z`), kind, direction: "in", from, to: number, profile: "campaign", lineKey: lineKey("campaign", number), ...overrides };
}
const repeated = [
  event("a-text-1", "2026-10-04"), event("a-text-2", "2026-10-04"),
  event("a-call", "2026-10-04", alice, "call"), event("b-call", "2026-10-04", bob, "call"),
  event("a-return", "2026-10-05"), event("c-text", "2026-10-05", carol),
  event("b-return", "2026-10-11", bob, "call"),
];

describe("unique campaign contacts", () => {
  test("deduplicates repeats and cross-channel contacts while leaving event counts intact", () => {
    const view = uniqueTraffic(repeated, days, "utc", "in");
    expect(view.totals).toEqual({ msgIn: 2, msgOut: 0, callIn: 2, callOut: 0, contacts: 3 });
    expect(view.rows.map((row) => row.contacts)).toEqual([2, 2, 0, 0, 0, 0, 0, 1]);
    expect(totalOf(view.totals)).toBe(3);
    expect(repeated.length).toBe(7);
  });

  test("weekly unique counts restart each week; cumulative counts deduplicate across weeks", () => {
    const weeks = uniqueTraffic(repeated, days, "utc", "in", "weekly");
    expect(weeks.rows.map((row) => [row.date, row.endDate, row.msgIn, row.callIn, row.contacts])).toEqual([
      ["2026-10-04", "2026-10-04", 1, 2, 2], ["2026-10-05", "2026-10-11", 2, 1, 3],
    ]);
    const cumulative = uniqueTraffic(repeated, days, "utc", "in", "weekly", true);
    expect(cumulative.rows.map((row) => [row.msgIn, row.callIn, row.contacts])).toEqual([[1, 2, 2], [2, 2, 3]]);
    expect(cumulative.totals.contacts).toBe(3); // Not the sum of weekly uniques (5).
    expect(uniqueTraffic(repeated, days, "utc", "in", "daily", true).rows.at(-1)?.contacts).toBe(3);
  });

  test("chart compression unions contacts across each bucket instead of summing or taking the last day", () => {
    const view = uniqueTraffic(repeated, days, "utc", "in", "daily", false, 1);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ date: "2026-10-04", endDate: "2026-10-11", msgIn: 2, callIn: 2, contacts: 3 });
  });

  test("normalizes phone formatting and channel prefixes and excludes unidentified callers", () => {
    const events = [event("a", "2026-10-04"), event("a-format", "2026-10-04", "(555) 999-0000"),
      event("a-channel", "2026-10-04", `whatsapp:${alice}`, "call"),
      ...["anonymous", "Unknown", "restricted", "", "client:agent", "---"].map((from, index) => event(`unknown-${index}`, "2026-10-04", from, "call"))];
    expect(uniqueTraffic(events, days, "utc", "in").totals).toEqual({ msgIn: 1, msgOut: 0, callIn: 1, callOut: 0, contacts: 1 });
  });

  test("applies direction and date boundaries, counting outgoing recipients and mixed-direction contacts once", () => {
    const events = [event("in", "2026-10-04"), event("reply", "2026-10-04", number, "call", { direction: "out", to: alice }),
      event("out", "2026-10-04", number, "message", { direction: "out", to: bob }), event("before", "2026-10-03", carol), event("after", "2026-10-12", carol)];
    expect(uniqueTraffic(events, days, "utc", "in").totals.contacts).toBe(1);
    expect(uniqueTraffic(events, days, "utc", "out").totals).toMatchObject({ msgIn: 1, callIn: 1, contacts: 2 });
    expect(uniqueTraffic(events, days, "utc", "both").totals).toMatchObject({ msgIn: 2, callIn: 1, contacts: 2 });
  });

  test("uses local calendar dates, including around DST", () => {
    const previousTZ = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      const events = [event("late", "2026-03-09", alice, "message", { time: Date.parse("2026-03-09T06:30:00Z") })];
      const range = [{ date: "2026-03-08", ...emptyCounts() }, { date: "2026-03-09", ...emptyCounts() }];
      expect(uniqueTraffic(events, range, "local", "in").rows.map((row) => row.contacts)).toEqual([1, 0]);
      expect(uniqueTraffic(events, range, "utc", "in").rows.map((row) => row.contacts)).toEqual([0, 1]);
    } finally { if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ; }
  });

  test("preserves missing coverage and marks subsequent cumulative counts incomplete", () => {
    const range = days.map((row, index) => ({ ...row, coverage: index === 0 ? "missing" as const : "complete" as const }));
    const view = uniqueTraffic(repeated, range, "utc", "in", "weekly", true);
    expect(view.rows.map((row) => row.coverage)).toEqual(["partial", "partial"]);
    expect(view.totals.contacts).toBe(3);
  });

  test("scopes unique exports to the number and account, respects exclusions, and names the metric", () => {
    const data = buildDashboard([
      { profile: "campaign", owned: [number], events: [...repeated, event("excluded", "2026-10-05", "+15556660000")] },
      { profile: "other", owned: [number], events: [event("other-account", "2026-10-05", "+15554440000")] },
    ], 8, "utc", { endDay: "2026-10-11", excluded: ["5556660000"] });
    const csv = dashboardCsv(data, { unique: true, direction: "in", lineKey: lineKey("campaign", number) });
    expect(csv).toContain("unique_texters,unique_callers,unique_contacts");
    expect(csv).toContain('"total","2026-10-04..2026-10-11","campaign","+15550000001","","2","2","3","complete","in"');
    expect(csv).not.toContain('"other"');
    expect(dashboardCsv(data, { unique: true, direction: "in" })).toContain('"3","2","4","complete","in"');
  });
});
