import { describe, expect, test } from "bun:test";
import { buildDashboard, dashboardCsv, matchesFilter, numberMatchKey, shiftDay, type TrafficEvent } from "./aggregate";
import { brailleLineChart, niceMax, resample, sparkline, stackedColumns } from "./charts";
import { exclusionRows, helpSections } from "./components";
import { namesFromRecords, parseCliTsv, profilesFromTable, toEvents } from "./data";

const now = new Date("2026-10-06T18:00:00Z");
const line = "+15550000001";
const other = "+15550000002";
const tester = "+15559990000";
let sidCounter = 0;
const event = (iso: string, overrides: Partial<TrafficEvent> = {}): TrafficEvent => ({
  sid: `SM${sidCounter++}`,
  time: Date.parse(iso),
  kind: "message",
  direction: "in",
  from: tester,
  to: line,
  ...overrides,
});
const source = (events: TrafficEvent[], extra: { profile?: string; owned?: string[]; names?: Record<string, string> } = {}) => ({
  events,
  owned: [line, other],
  names: { [line]: "Guerrilla Marketing Line", [other]: "Support" },
  ...extra,
});

describe("parseCliTsv", () => {
  test("skips CLI update warnings and maps headers", () => {
    const output = [
      " ›   Warning: twilio-cli update available from 6.2.4 to 7.0.0.",
      "sid\tfrom\tto\tdirection\tstatus\tdateSent\tdateCreated",
      "SM1\t+15559990000\t+15550000001\tinbound\treceived\tOct 06 2026 10:16:19 GMT-0700\tOct 06 2026 10:16:16 GMT-0700",
      "SM2\t+15550000001\t+15559990000\toutbound-api\tdelivered\tOct 06 2026 11:09:48 GMT-0700\t",
    ].join("\n");
    const records = parseCliTsv(output);
    expect(records).toHaveLength(2);
    expect(records[0]!.from).toBe("+15559990000");
  });

  test("treats empty output as no records", () => {
    expect(parseCliTsv("")).toEqual([]);
    expect(parseCliTsv(" ›   Warning: twilio-cli update available\n ›   information: https://twil.io/cli")).toEqual([]);
  });

  test("rejects unexpected output", () => {
    expect(() => parseCliTsv("something went wrong")).toThrow();
  });
});

describe("toEvents", () => {
  test("keeps both directions and forwarded call parents", () => {
    const messages = toEvents([
      { sid: "SM1", from: "+1", to: "+2", direction: "inbound", dateSent: "2026-10-06T10:00:00Z" },
      { sid: "SM2", from: "+2", to: "+1", direction: "outbound-api", dateSent: "2026-10-06T10:00:00Z" },
      { sid: "SM3", from: "+1", to: "+2", direction: "", status: "received", dateSent: "", dateCreated: "2026-10-06T10:00:00Z" },
    ], "message");
    expect(messages.map((entry) => entry.direction)).toEqual(["in", "out", "in"]);
    const calls = toEvents([
      { sid: "CA2", from: "+1", to: "+3", direction: "outbound-dial", parentCallSid: "CA1", startTime: "2026-10-06T10:00:00Z" },
    ], "call");
    expect(calls[0]).toMatchObject({ direction: "out", parent: "CA1" });
  });
});

describe("profilesFromTable", () => {
  test("parses profiles:list output", () => {
    const profiles = profilesFromTable("ID  Account SID  Active\nprimary  AC123  false\ntwld-prod  AC456  true\n");
    expect(profiles).toEqual([
      { id: "primary", accountSid: "AC123", active: false },
      { id: "twld-prod", accountSid: "AC456", active: true },
    ]);
  });
});

describe("namesFromRecords", () => {
  test("ignores default friendly names that are just the number", () => {
    expect(namesFromRecords([
      { phoneNumber: "+15550000001", friendlyName: "Guerrilla Line" },
      { phoneNumber: "+15550000002", friendlyName: "(555) 000-0002" },
      { phoneNumber: "+15550000003", friendlyName: "/" },
    ])).toEqual({ "+15550000001": "Guerrilla Line" });
  });
});

describe("buildDashboard", () => {
  test("counts both directions, current and previous periods", () => {
    const data = buildDashboard([source([
      event("2026-10-06T01:00:00Z"),
      event("2026-10-06T02:00:00Z", { direction: "out", from: line, to: tester }),
      event("2026-10-05T01:00:00Z", { kind: "call" }),
      event("2026-09-29T12:00:00Z"), // previous 7-day period
      event("2026-09-01T12:00:00Z"), // outside both periods
    ])], 7, "utc", { now });
    expect(data.rows).toHaveLength(7);
    expect(data.rows[0]!.date).toBe("2026-09-30");
    expect(data.totals).toEqual({ msgIn: 1, msgOut: 1, callIn: 1, callOut: 0 });
    expect(data.previous.msgIn).toBe(1);
  });

  test("lists every owned line, even without traffic", () => {
    const data = buildDashboard([source([event("2026-10-06T01:00:00Z")])], 7, "utc", { now });
    expect(data.lines.map((entry) => entry.number).sort()).toEqual([line, other]);
    expect(data.lines.find((entry) => entry.number === other)!.name).toBe("Support");
  });

  test("merges WhatsApp traffic into the number's line", () => {
    const data = buildDashboard([source([
      event("2026-10-06T01:00:00Z", { from: `whatsapp:${tester}`, to: `whatsapp:${line}` }),
    ])], 7, "utc", { now });
    expect(data.lines.find((entry) => entry.number === line)!.msgIn).toBe(1);
  });

  test("credits forwarded call legs to the line that was called", () => {
    const data = buildDashboard([source([
      event("2026-10-06T01:00:00Z", { sid: "CA1", kind: "call", from: tester, to: line }),
      // Forwarded leg: Twilio reports the original caller as "from".
      event("2026-10-06T01:00:01Z", { sid: "CA2", kind: "call", direction: "out", from: tester, to: "+15551112222", parent: "CA1" }),
    ])], 7, "utc", { now });
    const target = data.lines.find((entry) => entry.number === line)!;
    expect(target.callIn).toBe(1);
    expect(target.callOut).toBe(1);
    expect(data.lines.some((entry) => entry.number === tester)).toBe(false);
  });

  test("does not double count inbound child legs answered by clients", () => {
    const data = buildDashboard([source([
      event("2026-10-06T01:00:00Z", { sid: "CA1", kind: "call", from: tester, to: line }),
      event("2026-10-06T01:00:01Z", { sid: "CA2", kind: "call", direction: "in", from: "client:dev-phone", to: "Unknown", parent: "CA1" }),
    ])], 7, "utc", { now });
    expect(data.totals.callIn).toBe(1);
    expect(data.lines.some((entry) => entry.number === "Unknown")).toBe(false);
  });

  test("excludes forwarded legs of calls from an excluded caller", () => {
    const data = buildDashboard([source([
      event("2026-10-06T01:00:00Z", { sid: "CA1", kind: "call", from: tester, to: line }),
      event("2026-10-06T01:00:01Z", { sid: "CA2", kind: "call", direction: "out", from: tester, to: "+15551112222", parent: "CA1" }),
    ])], 7, "utc", { now, excluded: [tester] });
    expect(data.totals).toEqual({ msgIn: 0, msgOut: 0, callIn: 0, callOut: 0 });
  });

  test("excludes traffic with excluded numbers in any format, in both directions", () => {
    const data = buildDashboard([source([
      event("2026-10-06T01:00:00Z"),
      event("2026-10-06T02:00:00Z", { direction: "out", from: line, to: tester }),
      event("2026-10-06T03:00:00Z", { from: "+15557770000" }),
    ])], 7, "utc", { now, excluded: ["(555) 999-0000"] });
    expect(data.totals).toEqual({ msgIn: 1, msgOut: 0, callIn: 0, callOut: 0 });
    expect(data.excludedEvents).toBe(2);
    // Owned lines stay listed after exclusions.
    expect(data.lines).toHaveLength(2);
    // Excluded numbers still appear among peers so they can be un-excluded.
    expect(data.peers.map((peer) => peer.number)).toContain(tester);
  });

  test("filters lines by friendly name", () => {
    const data = buildDashboard([source([
      event("2026-10-06T01:00:00Z"),
      event("2026-10-06T01:00:00Z", { to: other }),
    ])], 7, "utc", { now, filter: "guerilla" });
    expect(data.lines.map((entry) => entry.number)).toEqual([line]);
    expect(data.totals.msgIn).toBe(1);
    expect(data.filteredOut).toBe(1);
  });

  test("keeps the same number separate per account", () => {
    const events = [event("2026-10-06T01:00:00Z")];
    const data = buildDashboard([source(events, { profile: "a" }), source(events, { profile: "b" })], 7, "utc", { now });
    expect(data.lines.filter((entry) => entry.number === line)).toHaveLength(2);
    expect(data.totals.msgIn).toBe(2);
  });

  test("exports CSV with quoted values", () => {
    const data = buildDashboard([source([event("2026-10-06T01:00:00Z")], { profile: "p\"x" })], 7, "utc", { now });
    const csv = dashboardCsv(data);
    expect(csv.split("\n")[0]).toBe("scope,date_utc,account,line,name,messages_in,messages_out,calls_in,calls_out,total");
    expect(csv).toContain(`"line_daily","2026-10-06","p""x","${line}","Guerrilla Marketing Line","1","0","0","0","1"`);
  });
});

describe("filters and exclusions", () => {
  test("matchesFilter supports any-of and minus terms", () => {
    expect(matchesFilter("guerilla", "Guerrilla Line", line)).toBe(true);
    expect(matchesFilter("guerilla, support", "Support", other)).toBe(true);
    expect(matchesFilter("-dev", "Stefani Dev phone", other)).toBe(false);
    expect(matchesFilter("", undefined, line)).toBe(true);
  });

  test("numberMatchKey normalizes formats", () => {
    expect(numberMatchKey("(555) 999-0000")).toBe(numberMatchKey("+15559990000"));
    expect(numberMatchKey("whatsapp:+15559990000")).toBe("15559990000");
    expect(numberMatchKey("client:Alice")).toBe("client:alice");
  });

  test("exclusionRows puts excluded numbers first", () => {
    const rows = exclusionRows(
      [{ number: tester, msgIn: 3, msgOut: 0, callIn: 0, callOut: 0 }, { number: "+15557770000", msgIn: 1, msgOut: 0, callIn: 0, callOut: 0 }],
      ["555-777-0000"],
    );
    expect(rows.map((row) => [row.number, row.excluded])).toEqual([["555-777-0000", true], [tester, false]]);
  });
});

describe("charts", () => {
  test("shiftDay crosses month and year boundaries", () => {
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDay("2026-02-28", 1)).toBe("2026-03-01");
  });

  test("niceMax rounds up to readable values", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(180)).toBe(200);
    expect(niceMax(2100)).toBe(2500);
  });

  test("resample sums buckets", () => {
    expect(resample([1, 2, 3, 4], 2, "sum")).toEqual([3, 7]);
    expect(resample([1, 2], 5)).toEqual([1, 2]);
  });

  test("line chart fills the requested size", () => {
    const lines = brailleLineChart([{ values: [0, 5, 10, 5, 0], color: "c" }], 20, 4, 10, { overlapColor: "o", emptyColor: "e" });
    expect(lines).toHaveLength(4);
    for (const row of lines) expect(row.map((segment) => segment.text).join("")).toHaveLength(20);
    expect(lines[0]!.some((segment) => segment.fg === "c")).toBe(true);
  });

  test("stacked columns never exceed the width", () => {
    const { lines } = stackedColumns(Array.from({ length: 90 }, (_, i) => i), Array.from({ length: 90 }, () => 3), 40, 5, { bottomColor: "a", topColor: "b", emptyColor: "e" });
    for (const row of lines) expect(row.map((segment) => segment.text).join("").length).toBeLessThanOrEqual(40);
  });

  test("sparkline handles empty and flat series", () => {
    expect(sparkline([0, 0, 0], 3)).toBe("···");
    expect(sparkline([1, 1], 2)).toBe("██");
  });
});

describe("help", () => {
  test("lists every main-view shortcut", async () => {
    const source = await Bun.file(`${import.meta.dir}/App.tsx`).text();
    // Keys handled after the overlays (picker, exclusions, filter input, help) return early.
    const main = source.slice(source.indexOf('if (key.sequence === "?")'), source.indexOf("if (picker.open) {\n    return"));
    const keys = new Set([...main.matchAll(/key\.(?:name|sequence) === "([^"]+)"/g)].map((match) => match[1]!));
    const helpText = helpSections.flatMap((section) => section.rows.map(([combo]) => combo)).join(" ").toLowerCase();
    const aliases: Record<string, string> = {
      escape: "esc", backspace: "backspace", up: "↑", down: "↓", left: "←", right: "→", tab: "tab", u: "ctrl+u",
    };
    const missing = [...keys].filter((key) => !helpText.includes((aliases[key] ?? key).toLowerCase()));
    expect(missing).toEqual([]);
  });
});
