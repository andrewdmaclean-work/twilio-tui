import { expect, test } from "bun:test";
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TrafficStore } from "./storage";
import { calendarWindow, dayKey, shiftDay } from "./aggregate";

test("dashboard keyboard flows manage downloads and forget a disconnected account", async () => {
  const dir = mkdtempSync(join(tmpdir(), "twilio-flow-"));
  const cachePath = join(dir, "cache.sqlite");
  const settingsPath = join(dir, "settings.json");
  const today = dayKey(new Date(), "utc");
  const db = new TrafficStore(cachePath);
  db.save(["production", "gone"].map((id) => ({ id, coveredFrom: shiftDay(today, -60), fetchedThrough: today, updatedAt: Date.now(), owned: ["+15550000001"], events: [
    { sid: `SM-${id}`, time: Date.parse(`${today}T01:00:00Z`), kind: "message" as const, direction: "in" as const, from: "+15559990000", to: "+15550000001" },
    { sid: `CA-${id}`, time: Date.parse(`${today}T02:00:00Z`), kind: "call" as const, direction: "in" as const, from: "+15559990000", to: "+15550000001" },
    { sid: `SM-earlier-${id}`, time: Date.parse(`${shiftDay(today, -10)}T01:00:00Z`), kind: "message" as const, direction: "in" as const, from: "+15559990000", to: "+15550000001" },
    { sid: `SM-out-${id}`, time: Date.parse(`${today}T03:00:00Z`), kind: "message" as const, direction: "out" as const, from: "+15550000001", to: "+15559990000" },
    { sid: `CA-forwarded-${id}`, parent: `CA-${id}`, time: Date.parse(`${today}T02:00:01Z`), kind: "call" as const, direction: "out" as const, from: "+15559990000", to: "+15558880000" },
  ] })));
  db.close();
  try {
    await Bun.write(settingsPath, JSON.stringify({ profiles: ["production", "gone"], focus: null, filter: "", excluded: [], importPaused: true }));
    const cli = join(dir, "twilio");
    await Bun.write(cli, `#!/bin/sh
printf '%s\\n' "$1" >> "$TWILIO_TEST_CLI_LOG"
case "$1" in
  profiles:list) printf '[{"id":"production","accountSid":"ACfixture"}]\\n' ;;
  api:core:usage:records:all-time:list) printf 'startDate\\n2020-01-01\\n' ;;
  *) printf 'sid\\tfrom\\tto\\tdirection\\tdateSent\\tdateCreated\\tstartTime\\n' ;;
esac
`);
    chmodSync(cli, 0o700);
    // A separate process isolates module-level storage paths from the other tests.
    const script = join(dir, "flow.ts");
    const root = import.meta.dir;
    await Bun.write(script, `
      import { expect } from "bun:test";
      import { act, createElement } from ${JSON.stringify(`${root}/../node_modules/react/index.js`)};
      import { testRender } from ${JSON.stringify(`${root}/../node_modules/@opentui/react/test-utils.js`)};
      import { App } from ${JSON.stringify(`${root}/App.tsx`)};
      const ui = await testRender(createElement(App), { width: 120, height: 40 });
      const frame = () => ui.captureCharFrame();
      async function settle() { await act(async () => { await Bun.sleep(40); }); await ui.renderOnce(); }
      async function key(value) { await act(async () => { await ui.mockInput.pressKeys([value]); }); await settle(); }
      function summary(texts, calls) {
        const rendered = frame().replaceAll("≥", "");
        expect(rendered).toContain("TEXTS IN " + texts);
        expect(rendered).toContain("CALLS IN " + calls);
        expect(rendered).toContain("EVENTS " + (texts + calls));
      }
      async function click(label) {
        const rows = frame().split("\\n");
        const y = rows.findIndex((row) => row.includes(label));
        if (y < 0) throw new Error("Missing click target: " + label + "\\n" + frame());
        expect(y).toBeGreaterThanOrEqual(0);
        await act(async () => { await ui.mockMouse.click(rows[y].indexOf(label) + 1, y); });
        await settle();
      }
      async function type(value) { await act(async () => { await ui.mockInput.typeText(value); }); await settle(); }
      async function action(label) {
        await click("Actions");
        for (let index = 0; index < 40 && !frame().includes(label); index++) await click("↓ Next");
        await click(label);
      }
      try {
        for (let i = 0; i < 30 && !frame().includes("ALL 2"); i++) await settle();
        expect(frame()).toContain("ALL 2");
        await act(async () => ui.resize(80, 24)); await settle();
        for (const label of ["W dates", "V activity", "B downloads", "P accounts", "? help", "7D", "30D", "90D", "Dates…", "Older", "Newer", "Today", "Q quit"]) expect(frame()).toContain(label);
        expect(frame()).not.toContain("Space MENU");
        expect(frame()).not.toContain("HISTORY DOWNLOADS · PAUSED");
        expect(frame().split("\\n").findIndex((row) => row.includes("ALL LINES"))).toBeLessThanOrEqual(7);
        summary(4, 2);
        expect(frame()).toContain("CUMULATIVE");
        expect(frame()).toContain("EVENTS ≥6");
        await action("Filter phone lines");
        await type("no-matching-line"); await click("Apply"); summary(0, 0);
        await click("Edit filter"); await click("Clear"); await click("Apply"); summary(4, 2);
        await action("Filter phone lines"); await type("discarded-filter"); await click("Cancel"); summary(4, 2);
        await action("Exclude outside numbers");
        await click("+15559990000"); await click("Done"); summary(0, 0);
        await click("X exclusions"); await click("+15559990000"); await click("Done"); summary(4, 2);
        await action("Exclude outside numbers"); await click("N Add number");
        await type("+15554440000"); await click("Add number"); await click("Done"); summary(4, 2);
        await click("X exclusions"); await click("+15554440000"); await click("Done"); summary(4, 2);
        await click("? help"); await click("Close help"); expect(frame()).toContain("Actions");
        await click("C CUMULATIVE");
        const graphRows = frame().split("\\n");
        const graphY = graphRows.findIndex((row) => row.includes(" ┤"));
        await act(async () => { await ui.mockMouse.click(graphRows[graphY].indexOf("┤") + 2, graphY); }); await settle();
        expect(frame()).toContain("ACTIVITY · 0 events"); summary(4, 2);
        await click("Full window"); expect(frame()).toContain("ACTIVITY · 6 events"); summary(4, 2);
        await click("V lines"); await click("C DAILY");
        await click("I DAILY"); expect(frame()).toContain("I WEEKLY"); summary(4, 2);
        expect(frame()).toContain("C CUMULATIVE");
        await key("c"); expect(frame()).toContain("C WEEKLY"); summary(4, 2);
        await key("c"); expect(frame()).toContain("C CUMULATIVE");
        await click("N Events");
        expect(frame()).toContain("N Unique contacts");
        for (const label of ["TEXTERS ≥1", "CALLERS ≥1", "CONTACTS ≥1"]) expect(frame()).toContain(label);
        expect(frame()).not.toContain("COMPARISON");
        await key("g"); expect(frame()).toContain("G Show chart");
        expect(frame()).toContain("CONTACTS ≥1"); // Unique summary works without the visual.
        await key("g"); expect(frame()).toContain("I WEEKLY");
        await key("n"); summary(4, 2);
        const tableTop = () => frame().split("\\n").findIndex((row) => row.includes("╭─ LINES ·"));
        const withChart = tableTop();
        await click("G Hide chart");
        expect(frame()).toContain("G Show chart");
        expect(frame()).not.toContain("CUMULATIVE");
        expect(tableTop()).toBeLessThan(withChart);
        summary(4, 2);
        await key("0"); summary(2, 2); // Dates and totals still work with the chart hidden.
        await key("2"); summary(4, 2);
        await key("g"); expect(frame()).toContain("CUMULATIVE"); summary(4, 2);
        expect(frame()).toContain("I WEEKLY"); // Grouping survives hiding the chart and changing dates.
        await key("i"); expect(frame()).toContain("I DAILY");
        await act(async () => ui.resize(160, 40)); await settle();
        await key("g");
        const expandedTable = frame().split("\\n").find((row) => row.includes("╭─ LINES ·"));
        expect(expandedTable.lastIndexOf("╮")).toBeGreaterThan(150);
        await key("c"); expect(frame()).toContain("CUMULATIVE"); // C reopens the cumulative visual.
        await act(async () => ui.resize(80, 24)); await settle();
        await key("RETURN"); expect(frame()).toContain("CAMPAIGN"); summary(2, 1);
        await key("n");
        for (const label of ["TEXTERS ≥1", "CALLERS ≥1", "CONTACTS ≥1"]) expect(frame()).toContain(label);
        await key("n"); summary(2, 1);
        await key("v");
        expect(frame()).toContain("CA-gone");
        expect(frame()).not.toContain("CA-production");
        expect(frame()).not.toContain("SM-out-");
        expect(frame()).not.toContain("CA-forwarded-");
        await key("g"); summary(2, 1);
        expect(frame()).toContain("CA-gone"); // Activity and selection survive hiding the chart.
        await key("g"); summary(2, 1);
        await key("m"); summary(2, 1); // The event-type filter does not alter campaign totals.
        await key("0"); summary(1, 1);
        await key("2"); summary(2, 1);
        await key("ESCAPE"); summary(4, 2);
        await key("-"); expect(frame()).toContain(${JSON.stringify(shiftDay(today, -30))});
        await key("="); expect(frame()).toContain(${JSON.stringify(today)});
        await key("-"); await key("+"); expect(frame()).toContain(${JSON.stringify(today)});
        await key(" "); expect(frame()).toContain("DASHBOARD ACTIONS");
        await key("w"); expect(frame()).toContain("DASHBOARD ACTIONS");
        await key("ARROW_DOWN"); await key("RETURN");
        expect(frame()).toContain("CA-gone");
        await key("ESCAPE"); expect(frame()).toContain("V activity");
        await key("ESCAPE"); // Back at the dashboard must not quit.
        await key(" "); await key("RETURN"); expect(frame()).toContain("TIME WINDOW");
        await click("Esc CANCEL"); expect(frame()).toContain("W dates");
        await click("W dates"); await click("MTD · Month to date"); await click("APPLY WINDOW");
        expect(frame()).toContain(${JSON.stringify("MTD · " + calendarWindow("mtd", "utc").start + " → " + today)});
        await key("-"); expect(frame()).not.toContain("MTD ·");
        await key("h"); await key("2"); summary(4, 2);
        await act(async () => ui.resize(160, 40)); await settle();
        await click("QTD");
        expect(frame()).toContain(${JSON.stringify("QTD · " + calendarWindow("qtd", "utc").start + " → " + today)});
        await key("0"); expect(frame()).not.toContain("QTD ·");
        await act(async () => ui.resize(80, 24)); await settle(); summary(2, 2);
        await key("2"); summary(4, 2);
        await click("B downloads"); expect(frame()).toContain("HISTORY DOWNLOADS");
        await click("G OLDEST DATE"); await type(${JSON.stringify(shiftDay(today, -60))}); await click("Apply date");
        expect(frame()).toContain("G OLDEST DATE");
        await click("G OLDEST DATE"); await click("Cancel date");
        await click("Esc BACK"); expect(frame()).toContain("W dates");
        await click("P accounts"); expect(frame()).toContain("MANAGE ACCOUNTS");
        for (let i = 0; i < 100 && !frame().includes("disconnected"); i++) await settle();
        expect(frame()).toContain("disconnected");
        expect(frame()).toContain("F FORGET SELECTED");
        expect(frame()).toContain("Esc cancel");
        await click("gone");
        await click("F FORGET SELECTED"); expect(frame()).toContain("Forget gone?");
        await click("N/Esc cancel"); expect(frame()).not.toContain("Forget gone?");
        await click("Esc CANCEL");
        await key("?"); expect(frame()).toContain("↑↓ scroll");
        await key(" "); expect(frame()).toContain("DASHBOARD ACTIONS");
        await key("ESCAPE");
        await act(async () => ui.resize(120, 40)); await settle();
        expect(frame()).toContain("TEXTS RECEIVED");
        expect(frame()).toContain("CALLS RECEIVED");
        await key("c"); expect(frame()).toContain("C DAILY");
        await key("c"); expect(frame()).toContain("C CUMULATIVE");
        await key("v"); expect(frame()).toContain("ACTIVITY");
        expect(frame()).toContain("CA-gone");
        await key("m"); expect(frame()).toContain("4 messages · 0 calls");
        await key("w"); expect(frame()).toContain("TIME WINDOW");
        await key("ESCAPE"); expect(frame()).toContain("ACTIVITY");
        await key("b"); expect(frame()).toContain("HISTORY DOWNLOADS");
        await key("i"); expect(frame()).toContain("30 MIN");
        await key(" "); expect(frame()).toContain("1 account(s) selected");
        await key("ESCAPE");
        await key("p");
        for (let i = 0; i < 30 && !frame().includes("disconnected"); i++) await settle();
        expect(frame()).toContain("disconnected");
        await key("ARROW_DOWN");
        await key("f"); expect(frame()).toContain("Forget gone?");
        await key("n"); expect(frame()).not.toContain("Forget gone?");
        await key("BACKSPACE"); await key("y");
        await key("d");
        expect(frame()).not.toContain("ALL 2");
        await key("b"); expect(frame()).not.toContain("[✓] gone");
        await key("ESCAPE");
        await key("0");
        for (let i = 0; i < 10; i++) await key(",");
        expect(frame()).toContain("1 missing");
        await key("u");
        expect(frame()).toContain("DOWNLOAD WINDOW · PREVIEW");
        expect(frame()).toContain("1 missing account-days");
        await key("i");
        await key("ESCAPE");
        const cancelled = await Bun.file(process.env.TWILIO_TUI_SETTINGS).json();
        expect(cancelled.history.intervalMinutes).toBe(30);
        expect(cancelled.history.endDay).toBeUndefined();
        await key("u");
        await key("i");
        await key("s");
        for (let i = 0; i < 30 && !frame().includes("0 missing account-days"); i++) await settle();
        expect(frame()).toContain("0 missing account-days");
        await key("ESCAPE");
        expect(frame()).toContain("DATA 1/1 days complete");
      } finally { await act(async () => ui.renderer.destroy()); }
    `);
    const child = Bun.spawn([process.execPath, "run", script], { cwd: import.meta.dir + "/..", env: {
      ...process.env, PATH: `${dir}:${process.env.PATH}`, TWILIO_TUI_CACHE: cachePath, TWILIO_TUI_SETTINGS: settingsPath,
      TWILIO_TEST_CLI_LOG: join(dir, "cli.log"),
      TWILIO_CLI_PROFILE: "", TWILIO_CLI_PROFILES: "",
    }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: stdout + stderr, cli: code === 0 ? "" : await Bun.file(join(dir, "cli.log")).text().catch(() => "no CLI calls") }).toEqual({ code: 0, output: "", cli: "" });
    const saved = await Bun.file(settingsPath).json();
    expect(saved.profiles).toEqual(["production"]);
    expect(saved.history.intervalMinutes).toBe(1);
    expect(saved.history.startDay).toBe(shiftDay(today, -70));
    expect(saved.history.endDay).toBe(shiftDay(today, -70));
    const reopened = new TrafficStore(cachePath);
    try {
      const rows = reopened.load();
      expect(rows.map((row) => row.id)).toEqual(["production"]);
      expect(rows[0]!.coverageRanges).toContainEqual({ from: shiftDay(today, -70), through: shiftDay(today, -70) });
      expect(rows[0]!.coveredFrom).toBe(shiftDay(today, -60));
    }
    finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 25_000);
