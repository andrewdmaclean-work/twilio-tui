import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ActionsScreen, WindowScreen, DownloadsScreen, ActivityTable } from "./screens";
import { HelpOverlay, ProfilePicker, TrafficChart } from "./components";
import { SavedViewsScreen } from "./saved-views";
import { EventDetailScreen } from "./event-detail-screen";
import { saveNamedView, type SavedView } from "./views";
import { calendarWindow, emptyCounts, shiftDay, uniqueTraffic, type ActivityEvent } from "./aggregate";

let ui: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(async () => { await act(async () => { ui?.renderer.destroy(); }); ui = undefined; });

async function press(action: () => void | Promise<void>) {
  await act(async () => { await action(); });
  await ui!.renderOnce();
}

async function click(label: string) {
  const rows = ui!.captureCharFrame().split("\n");
  const y = rows.findIndex((row) => row.includes(label));
  expect(y).toBeGreaterThanOrEqual(0);
  await press(() => ui!.mockMouse.click(rows[y]!.indexOf(label) + 1, y));
}

test("actions beyond the visible page are reachable with the mouse and can be opened by clicking", async () => {
  let selected = -1;
  const actions = Array.from({ length: 25 }, (_, index) => ({ label: `Action ${index}`, shortcut: "", description: `Description ${index}`, run: () => { selected = index; } }));
  ui = await testRender(<ActionsScreen actions={actions} width={80} height={24} onClose={() => {}} />, { width: 80, height: 24 });
  await ui.renderOnce();
  for (let index = 0; index < 24; index++) await press(() => ui!.mockMouse.scroll(10, 6, "down"));
  expect(ui.captureCharFrame()).toContain("25 / 25 actions");
  await click("↑ Previous");
  expect(ui.captureCharFrame()).toContain("24 / 25 actions");
  await click("↓ Next");
  await click("Action 24");
  expect(selected).toBe(24);
});

for (const chartType of ["line", "bars", "spark", "table"] as const) {
  for (const cumulative of [false, true]) {
    test(`${chartType} ${cumulative ? "cumulative" : "weekly"} chart clicks select the dates represented by the plot`, async () => {
      let selected: string[] | undefined;
      const rows = Array.from({ length: 12 }, (_, index) => ({ date: shiftDay("2026-10-01", index), ...emptyCounts(), msgIn: 1 }));
      ui = await testRender(<TrafficChart rows={rows} previous={emptyCounts()} direction="in" width={80} height={12} title="CAMPAIGN" chartType={chartType} timeZone="utc" interval="weekly" cumulative={cumulative}
        onSelectRange={(from, through) => { selected = [from, through]; }} />, { width: 80, height: 12 });
      await ui.renderOnce();
      // Middle plot point (or the middle weekly table row) is October 5–11.
      await press(() => ui!.mockMouse.click(chartType === "table" ? 10 : 42, chartType === "table" ? 4 : 2));
      expect(selected).toEqual([cumulative ? "2026-10-01" : "2026-10-05", "2026-10-11"]);
      if (chartType !== "table") {
        selected = undefined;
        await press(() => ui!.mockMouse.click(2, 2)); // Axis labels are not periods.
        expect(selected).toBeUndefined();
      }
    });
  }
}

test("activity rows select details by click and scroll to offscreen events with the mouse", async () => {
  const events: ActivityEvent[] = Array.from({ length: 20 }, (_, index) => ({ sid: `SM-detail-${index}`, time: Date.parse("2026-10-09T12:00:00Z") + index * 1000,
    kind: "message", direction: "in", from: `+1555999${String(index).padStart(4, "0")}`, to: "+15550000001", lineKey: "campaign" }));
  function Activity() {
    const [cursor, setCursor] = useState(0);
    return <ActivityTable events={events} direction="in" timeZone="utc" width={80} height={12} cursor={cursor} kind="all" onKind={() => {}}
      onSelect={setCursor} onScroll={(step) => setCursor((value) => Math.max(0, Math.min(events.length - 1, value + step)))} />;
  }
  ui = await testRender(<Activity />, { width: 80, height: 12 });
  await ui.renderOnce();
  await click("+15559990002");
  expect(ui.captureCharFrame()).toContain("SM-detail-2");
  for (let index = 0; index < 20; index++) await press(() => ui!.mockMouse.scroll(12, 4, "down"));
  expect(ui.captureCharFrame()).toContain("SM-detail-19");
});

test("actions menu scrolls with ordinary arrows and opens the selected action with Return", async () => {
  let selected = -1;
  const actions = Array.from({ length: 20 }, (_, index) => ({ label: `Action ${index}`, shortcut: "", description: `Description ${index}`, run: () => { selected = index; } }));
  ui = await testRender(<ActionsScreen actions={actions} width={80} height={24} onClose={() => {}} />, { width: 80, height: 24 });
  await ui.renderOnce();
  expect(ui.captureCharFrame()).toContain("Return open");
  for (let index = 0; index < 19; index++) await press(() => ui!.mockInput.pressArrow("down"));
  expect(ui.captureCharFrame()).toContain("20 / 20 actions");
  expect(ui.captureCharFrame()).toContain("Description 19");
  await press(() => ui!.mockInput.pressEnter());
  expect(selected).toBe(19);
});

test("keyboard help scrolls to lower sections using arrows on a compact terminal", async () => {
  ui = await testRender(<HelpOverlay width={80} height={24} />, { width: 80, height: 24 });
  await ui.renderOnce();
  expect(ui.captureCharFrame()).toContain("↑↓ scroll");
  for (let index = 0; index < 100; index++) await press(() => ui!.mockInput.pressArrow("down"));
  expect(ui.captureCharFrame()).toContain("Mac: use Space");
});

test("custom date screen applies dates and lets Tab edit the end without triggering dashboard keys", async () => {
  let result: unknown;
  ui = await testRender(<WindowScreen start="2026-10-01" end="2026-10-09" timeZone="utc" onApply={(period, end) => { result = { period, end }; }} onClose={() => {}} />, { width: 80, height: 24 });
  await ui.renderOnce();
  expect(ui.captureCharFrame()).toContain("TIME WINDOW");
  await press(() => ui!.mockInput.pressTab());
  // The existing date ends in 09; replace the last digit with 8.
  await press(() => ui!.mockInput.pressBackspace());
  await press(() => ui!.mockInput.typeText("8"));
  await press(() => ui!.mockInput.pressEnter());
  expect(result).toEqual({ period: 8, end: "2026-10-08" });
});

test("invalid dates remain on the date screen with an explanation", async () => {
  let applied = false;
  ui = await testRender(<WindowScreen start="2026-02-30" end="2026-03-01" timeZone="utc" onApply={() => { applied = true; }} onClose={() => {}} />, { width: 80, height: 24 });
  await press(() => ui!.mockInput.pressEnter());
  expect(applied).toBe(false);
  expect(ui.captureCharFrame()).toContain("Use valid dates");
});

test("disconnected account and its removal confirmation remain visible", async () => {
  ui = await testRender(<ProfilePicker profiles={[{ id: "gone", disconnected: true }]} selected={["gone"]} cursor={0} loading={false} error={null} height={24} confirmForget="gone" />, { width: 120, height: 24 });
  await ui.renderOnce();
  const frame = ui.captureCharFrame();
  expect(frame).toContain("disconnected");
  expect(frame).toContain("Forget gone?");
  expect(frame).toContain("Y confirm");
});

test("download screen shows controls and selected accounts at a standard terminal size", async () => {
  ui = await testRender(<DownloadsScreen accounts={["production", "staging"]} selected={["production"]} cursor={1} paused options={{ startDay: "2026-01-01", intervalMinutes: 5 }} progress={null} editing={null} notice={null} width={80} height={24}
    onToggle={() => {}} onRun={() => {}} onTarget={() => {}} onPace={() => {}} />, { width: 80, height: 24 });
  await ui.renderOnce();
  const frame = ui.captureCharFrame();
  expect(frame).toContain("HISTORY DOWNLOADS");
  expect(frame).toContain("S START / RESUME");
  expect(frame).toContain("5 MIN");
  expect(frame).toContain("[✓] production");
  expect(frame).toContain("[ ] staging");
  expect(frame).toContain("Esc/B back");
});

test("window download preview shows missing days and an estimate at 80 columns", async () => {
  ui = await testRender(<DownloadsScreen accounts={["production"]} selected={["production"]} cursor={0} paused preview
    options={{ startDay: "2026-10-01", endDay: "2026-10-05", intervalMinutes: 10 }} progress={null} editing={null} notice={null} width={80} height={24}
    plan={{ days: 3, minutes: 20, unavailable: 1, open: 1, accounts: [{ id: "production", days: ["2026-10-01", "2026-10-02", "2026-10-03"], unavailable: 1, open: 1 }] }}
    onToggle={() => {}} onRun={() => {}} onTarget={() => {}} onPace={() => {}} />, { width: 80, height: 24 });
  await ui.renderOnce();
  const frame = ui.captureCharFrame();
  expect(frame).toContain("DOWNLOAD WINDOW · PREVIEW");
  expect(frame).toContain("3 missing account-days");
  expect(frame).toContain("0h 20m");
  expect(frame).toContain("Esc cancels");
  expect(frame).toContain("Esc/B back");
});

for (const chartType of ["line", "bars", "spark", "table"] as const) {
  test(`${chartType} chart marks unknown coverage and omits incomplete comparisons`, async () => {
    ui = await testRender(<TrafficChart rows={[
      { date: "2026-10-01", ...emptyCounts(), msgIn: 2, coverage: "complete" },
      { date: "2026-10-02", ...emptyCounts(), coverage: "missing" },
      { date: "2026-10-03", ...emptyCounts(), msgIn: 2, coverage: "partial" },
    ]} previous={emptyCounts()} direction="both" width={100} height={12} title="WINDOW" chartType={chartType} timeZone="utc" comparisonComplete={false} />, { width: 100, height: 12 });
    await ui.renderOnce();
    const frame = ui.captureCharFrame();
    expect(frame).toContain("TEXTS ≥4");
    expect(frame).toContain("░");
    expect(frame).not.toContain("NaN");
    expect(frame).not.toContain("new");
    if (chartType === "table") expect(frame).toContain("—");
  });
}

for (const chartType of ["line", "bars", "spark", "table"] as const) {
  test(`${chartType} unique chart counts someone who calls and texts once in combined contacts`, async () => {
    const rows = [{ date: "2026-10-04", ...emptyCounts(), msgIn: 2, callIn: 1 }];
    const base = { time: Date.parse("2026-10-04T12:00:00Z"), from: "+15559990000", to: "+15550000001", direction: "in" as const, lineKey: "campaign" };
    const events: ActivityEvent[] = [{ ...base, sid: "text-1", kind: "message" }, { ...base, sid: "text-2", kind: "message" }, { ...base, sid: "call", kind: "call" }];
    const unique = uniqueTraffic(events, rows, "utc", "in", "weekly", true);
    ui = await testRender(<TrafficChart rows={rows} previous={emptyCounts()} direction="in" width={80} height={12} title="CAMPAIGN" chartType={chartType} timeZone="utc" interval="weekly" cumulative unique={unique}
      onToggleMode={() => {}} onToggleInterval={() => {}} />, { width: 80, height: 12 });
    await ui.renderOnce();
    const frame = ui.captureCharFrame();
    for (const label of ["UNIQUE CONTACTS", "TEXTERS 1", "CALLERS 1", "CONTACTS 1", "C CUMULATIVE", "I WEEKLY"]) expect(frame).toContain(label);
    if (chartType === "line" || chartType === "bars") expect(frame).toContain("1 ┤");
    if (chartType === "table") expect(frame).toMatch(/10-04–10-04 +1 +1 +1/);
  });
}

for (const cumulative of [false, true]) {
  test(`weekly table shows clipped week ranges and ${cumulative ? "cumulative" : "weekly"} counts`, async () => {
    ui = await testRender(<TrafficChart rows={[
      { date: "2026-10-04", ...emptyCounts(), msgIn: 2, callIn: 1, msgOut: 99 },
      { date: "2026-10-05", ...emptyCounts(), msgIn: 3, callIn: 2, msgOut: 99 },
      { date: "2026-10-06", ...emptyCounts(), msgIn: 4, callIn: 3, msgOut: 99 },
    ]} previous={emptyCounts()} direction="in" width={80} height={12} title="CAMPAIGN" chartType="table" timeZone="utc" interval="weekly" cumulative={cumulative}
      onToggleMode={() => {}} onToggleInterval={() => {}} />, { width: 80, height: 12 });
    await ui.renderOnce();
    const frame = ui.captureCharFrame();
    expect(frame).toContain("I WEEKLY");
    expect(frame).toContain("WEEK UTC");
    expect(frame).toContain("TEXTS 9");
    expect(frame).toContain("CALLS 6");
    expect(frame).toMatch(/10-04–10-04 +2 +1 +3/);
    expect(frame).toMatch(cumulative ? /10-05–10-06 +9 +6 +15/ : /10-05–10-06 +7 +5 +12/);
    expect(frame).not.toContain("99");
  });
}

test("cumulative table legend shows the final total instead of adding running totals", async () => {
  ui = await testRender(<TrafficChart rows={[{ date: "2026-10-01", ...emptyCounts(), msgIn: 2 }, { date: "2026-10-02", ...emptyCounts(), msgIn: 3 }]} previous={emptyCounts()} direction="both" width={100} height={12} title="WINDOW" chartType="table" timeZone="utc" cumulative />, { width: 100, height: 12 });
  await ui.renderOnce();
  const frame = ui.captureCharFrame();
  expect(frame).toContain("TEXTS 5");
  expect(frame).toContain("EVENTS 5");
  expect(frame).toContain("CUMULATIVE");
  expect(frame).toContain("2026-10-02");
});

for (const chartType of ["line", "bars", "spark", "table"] as const) {
  test(`${chartType} cumulative chart includes incoming texts, calls, and combined events`, async () => {
    ui = await testRender(<TrafficChart rows={[
      { date: "2026-10-01", ...emptyCounts(), msgIn: 2, callIn: 1, msgOut: 100, callOut: 100 },
      { date: "2026-10-02", ...emptyCounts(), msgIn: 3, callIn: 1, msgOut: 100, callOut: 100 },
    ]} previous={emptyCounts()} direction="in" width={80} height={12} title="CAMPAIGN" chartType={chartType} timeZone="utc" cumulative />, { width: 80, height: 12 });
    await ui.renderOnce();
    const frame = ui.captureCharFrame();
    expect(frame).toContain("TEXTS 5");
    expect(frame).toContain("CALLS 2");
    expect(frame).toContain("EVENTS 7");
    expect(frame).toContain("CUMULATIVE");
    if (chartType === "line") expect(frame).toContain("10 ┤"); // The scale includes the combined events series.
    if (chartType === "table") expect(frame).toMatch(/2026-10-02 +5 +2 +7/);
  });
}

test("activity view shows both messages and calls and selected SID", async () => {
  const base = { direction: "in" as const, from: "+15551110000", to: "+15552220000", lineKey: "line", profile: "prod" };
  ui = await testRender(<ActivityTable events={[{ ...base, sid: "SM1", time: Date.parse("2026-10-09T12:00:00Z"), kind: "message" }, { ...base, sid: "CA1", time: Date.parse("2026-10-09T11:00:00Z"), kind: "call" }]} direction="both" timeZone="utc" width={100} height={16} cursor={1} kind="all" onKind={() => {}} />, { width: 100, height: 16 });
  await ui.renderOnce();
  const frame = ui.captureCharFrame();
  expect(frame).toContain("MSG");
  expect(frame).toContain("CALL");
  expect(frame).toContain("CA1");
  expect(frame).toContain("1 messages · 1 calls");
});


for (const chartType of ["line", "bars", "spark", "table"] as const) {
  for (const interval of ["daily", "weekly"] as const) {
    for (const cumulative of [false, true]) {
      test(`${chartType} ${interval} ${cumulative ? "cumulative" : "period"} chart plots today's observed counts`, async () => {
        ui = await testRender(<TrafficChart rows={[
          { date: "2026-10-22", ...emptyCounts(), msgIn: 2, coverage: "complete" },
          { date: "2026-10-23", ...emptyCounts(), msgIn: 3, callIn: 1, coverage: "partial", inProgress: true },
        ]} previous={emptyCounts()} direction="in" width={100} height={12} title="WINDOW" chartType={chartType}
          timeZone="utc" interval={interval} cumulative={cumulative} comparisonComplete={false} />, { width: 100, height: 12 });
        await ui.renderOnce();
        const frame = ui.captureCharFrame();
        expect(frame).toContain("TEXTS ≥5");
        expect(frame).toContain("CALLS ≥1");
        expect(frame).toContain("SO FAR");
        expect(frame).not.toContain("░");
        expect(frame).not.toContain("NaN");
        expect(frame).not.toContain("new");
        if (chartType === "table") {
          expect(frame).toContain(" *");
          expect(frame).toContain(cumulative || interval === "weekly" ? "≥6" : "≥4");
        }
      });
    }
  }
}


for (const preset of ["mtd", "qtd"] as const) {
  test(`${preset.toUpperCase()} is selectable and applies at 80 columns`, async () => {
    let result: unknown;
    const expected = calendarWindow(preset, "utc");
    ui = await testRender(<WindowScreen start="2026-01-01" end="2026-01-31" timeZone="utc"
      onApply={(period, end, preset) => { result = { period, end, preset }; }} onClose={() => {}} />, { width: 80, height: 24 });
    await ui.renderOnce();
    await click(preset === "mtd" ? "MTD · Month to date" : "QTD · Quarter to date");
    expect(ui.captureCharFrame()).toContain(expected.start);
    expect(ui.captureCharFrame()).toContain(expected.end);
    await click("APPLY WINDOW");
    expect(result).toEqual({ period: expected.period, end: expected.end, preset });
  });
}

test("editing dates after a calendar preset applies a custom range", async () => {
  let result: unknown;
  ui = await testRender(<WindowScreen start="2026-10-01" end="2026-10-27" timeZone="utc" preset="mtd"
    onApply={(period, end, preset) => { result = { period, end, preset }; }} onClose={() => {}} />, { width: 80, height: 24 });
  await ui.renderOnce();
  await press(() => ui!.mockInput.pressTab());
  await press(() => ui!.mockInput.pressBackspace());
  await press(() => ui!.mockInput.typeText("6"));
  await press(() => ui!.mockInput.pressEnter());
  expect(result).toEqual({ period: 26, end: "2026-10-26", preset: null });
});


test("a fully hidden cumulative chart explains missing history and offers recovery actions", async () => {
  let action = "";
  ui = await testRender(<TrafficChart rows={[
    { date: "2026-10-01", ...emptyCounts(), coverage: "missing" },
    { date: "2026-10-02", ...emptyCounts(), msgIn: 5, coverage: "complete" },
  ]} previous={emptyCounts()} direction="in" width={80} height={12} title="CAMPAIGN" chartType="line" timeZone="utc" cumulative
    onToggleMode={() => { action = "period"; }} onDownload={() => { action = "download"; }}
    onChooseDates={() => { action = "dates"; }} onShowActivity={() => { action = "activity"; }} />, { width: 80, height: 12 });
  await ui.renderOnce();
  expect(ui.captureCharFrame()).toContain("Chart hidden by missing history");
  expect(ui.captureCharFrame()).toContain("TEXTS ≥5");
  for (const [label, expected] of [["Period counts", "period"], ["Download window", "download"], ["Choose dates", "dates"], ["View activity", "activity"]] as const) {
    await click(label); expect(action).toBe(expected);
  }
});

test("saved views support saving, restoring and removing a dashboard at 80 columns", async () => {
  const current: SavedView = { name: "", profiles: ["prod"], focus: null, filter: "campaign", excluded: [], period: 27,
    endDay: null, calendarPreset: "mtd", timeZone: "utc", direction: "in", chartType: "line", chartInterval: "weekly",
    cumulative: true, chartVisible: true, unique: true };
  let restored: SavedView | undefined;
  function Views() {
    const [views, setViews] = useState<SavedView[]>([]);
    return <SavedViewsScreen views={views} width={80} height={24} onClose={() => {}}
      onSave={(name) => { if (!name.trim()) return "Choose a name"; setViews(saveNamedView(views, { ...current, name })); return null; }}
      onLoad={(view) => { restored = view; }} onRemove={(name) => setViews(views.filter((view) => view.name !== name))} />;
  }
  ui = await testRender(<Views />, { width: 80, height: 24 });
  await ui.renderOnce();
  await click("N Name this view");
  await press(() => ui!.mockInput.typeText("Campaign"));
  await click("Save / update view");
  expect(ui.captureCharFrame()).toContain("Campaign · MTD");
  await click("Load selected");
  expect(restored).toMatchObject({ name: "Campaign", filter: "campaign", unique: true, chartInterval: "weekly", calendarPreset: "mtd" });
  await click("Remove selected");
  expect(ui.captureCharFrame()).toContain("No saved views yet");
});

test("call details fetch webhook exchanges and errors only when opened", async () => {
  const requests: string[] = [];
  const event: ActivityEvent = { sid: `CA${"b".repeat(32)}`, kind: "call", direction: "in", time: 0, from: "+15551110000", to: "+15552220000", profile: "prod", lineKey: "line" };
  await act(async () => { ui = await testRender(<EventDetailScreen event={event} width={80} timeZone="utc" onClose={() => {}}
    loadDetail={async () => { requests.push("detail"); return { fields: [["Status", "failed"], ["Duration (seconds)", "0"]] }; }}
    loadExchanges={async () => { requests.push("webhooks"); return [{ method: "POST", url: "https://example.test/voice", parameters: "call_sid=CAfixture", status: "500", duration: "125", time: "2026-10-27T10:00:00Z", contentType: "application/xml", body: "<Response><Say>Hello</Say></Response>" }]; }}
    loadDiagnostics={async () => { requests.push("diagnostics"); return [{ level: "ERROR", code: "11200", message: "HTTP retrieval failure", time: "2026-10-27T10:00:00Z", url: "https://example.test/voice", method: "POST" }]; }} />, { width: 80, height: 24 }); });
  await ui!.renderOnce();
  expect(requests).toEqual(["detail"]);
  expect(ui!.captureCharFrame()).toContain("failed");
  await click("Webhook exchanges");
  expect(requests).toEqual(["detail", "webhooks"]);
  expect(ui!.captureCharFrame()).toContain("HTTP 500");
  expect(ui!.captureCharFrame()).toContain("<Response><Say>Hello</Say></Response>");
  await click("Errors & warnings");
  expect(requests).toEqual(["detail", "webhooks", "diagnostics"]);
  expect(ui!.captureCharFrame()).toContain("ERROR 11200");
  expect(ui!.captureCharFrame()).toContain("HTTP retrieval failure");
});

test("closing details aborts the pending read and unavailable records show a useful error", async () => {
  let signal: AbortSignal | undefined;
  const event: ActivityEvent = { sid: `SM${"a".repeat(32)}`, kind: "message", direction: "in", time: 0, from: "from", to: "to", lineKey: "line" };
  await act(async () => { ui = await testRender(<EventDetailScreen event={event} width={80} timeZone="utc" onClose={() => {}}
    loadDetail={async (_event, received) => { signal = received; throw new Error("Record no longer available"); }} />, { width: 80, height: 24 }); });
  await ui!.renderOnce();
  expect(ui!.captureCharFrame()).toContain("Record no longer available");
  await act(async () => { ui!.renderer.destroy(); }); ui = undefined;
  expect(signal?.aborted).toBe(true);
});
