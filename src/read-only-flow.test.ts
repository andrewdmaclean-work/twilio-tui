import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TrafficStore } from "./storage";
import { dayKey, shiftDay } from "./aggregate";

test("saved campaigns restore and individual records use only account-scoped read requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "twilio-details-"));
  const cachePath = join(dir, "cache.sqlite"), settingsPath = join(dir, "settings.json"), logPath = join(dir, "cli.log");
  const today = dayKey(new Date(), "utc");
  const messageSid = `SM${"a".repeat(32)}`, callSid = `CA${"b".repeat(32)}`;
  const body = "PRIVATE_MESSAGE_BODY\nSecond line";
  const db = new TrafficStore(cachePath);
  db.save([{ id: "prod", coveredFrom: shiftDay(today, -60), fetchedThrough: today, updatedAt: Date.now(),
    owned: ["+15552220000"], names: { "+15552220000": "Campaign" }, events: [
      { sid: messageSid, kind: "message", direction: "in", time: Date.now() - 1000, from: "+15551110000", to: "+15552220000" },
      { sid: callSid, kind: "call", direction: "in", time: Date.now() - 2000, from: "+15551110000", to: "+15552220000" },
    ] }]);
  db.close();
  try {
    await Bun.write(settingsPath, JSON.stringify({ profiles: ["prod"], focus: null, filter: "", excluded: [], importPaused: true }));
    const cli = join(dir, "twilio");
    const outputs = {
      "api:core:messages:fetch": [{ sid: messageSid, status: "received", from: "+15551110000", to: "+15552220000", body }],
      "api:core:calls:fetch": [{ sid: callSid, status: "completed", duration: "45" }],
      "api:core:calls:events:list": [{ request: { method: "POST", url: "https://example.test/voice", parameters: { call_sid: callSid } },
        response: { response_code: 200, content_type: "application/xml", response_body: "<Response><Say>Hello</Say></Response>", request_duration: 25 } }],
      "api:core:calls:notifications:list": [{ log: "0", errorCode: "11200", messageText: "HTTP retrieval failure" }],
    };
    await Bun.write(cli, `#!/usr/bin/env bun
const outputs = ${JSON.stringify(outputs)};
const args = process.argv.slice(2);
await Bun.write(process.env.TWILIO_TEST_CLI_LOG, (await Bun.file(process.env.TWILIO_TEST_CLI_LOG).text().catch(() => "")) + JSON.stringify(args) + "\\n");
if (!outputs[args[0]]) throw new Error("Unexpected command: " + args[0]);
process.stdout.write(JSON.stringify(outputs[args[0]]));
`);
    chmodSync(cli, 0o700);
    const root = import.meta.dir;
    const script = join(dir, "read-flow.ts");
    await Bun.write(script, `
import { expect } from "bun:test";
import { act, createElement } from ${JSON.stringify(`${root}/../node_modules/react/index.js`)};
import { testRender } from ${JSON.stringify(`${root}/../node_modules/@opentui/react/test-utils.js`)};
import { App } from ${JSON.stringify(`${root}/App.tsx`)};
import { loadSettings } from ${JSON.stringify(`${root}/data.ts`)};
const ui = await testRender(createElement(App), { width: 120, height: 36 });
const frame = () => ui.captureCharFrame();
async function settle() { await act(async () => { await Bun.sleep(40); }); await ui.renderOnce(); }
async function key(value) { await act(async () => { await ui.mockInput.pressKeys([value]); }); await settle(); }
async function type(value) { await act(async () => { await ui.mockInput.typeText(value); }); await settle(); }
async function click(label) {
  const rows = frame().split("\\n"), y = rows.findIndex((row) => row.includes(label));
  if (y < 0) throw new Error("Missing target: " + label + "\\n" + frame());
  await act(async () => { await ui.mockMouse.click(rows[y].indexOf(label) + 1, y); }); await settle();
}
async function waitFor(label) { for (let i = 0; i < 60 && !frame().includes(label); i++) await settle(); expect(frame()).toContain(label); }
try {
  await waitFor("Campaign");
  await key("/"); await type("Campaign"); await click("Apply");
  await key("RETURN"); await key("n"); await key("i"); await key("g");
  await key("w"); await click("MTD · Month to date"); await click("APPLY WINDOW");
  await key("s"); await click("N Name this view"); await type("Campaign MTD"); await click("Save / update view");
  await click("Done");
  await key("g"); await key("n"); await key("d"); await key("2"); await key("ESCAPE");
  await key("s"); await click("Load selected");
  expect(frame()).toContain("N Unique contacts");
  expect(frame()).toContain("G Show chart");
  expect(frame()).toContain("MTD ·");
  expect(frame()).toContain("◂ BACK");
  expect(frame()).toContain("UNIQUE: each number counted once");
  await key("g"); expect(frame()).toContain("I WEEKLY");
  await key("ESCAPE"); expect(frame()).toContain("line counts may overlap");
  await key("n"); await key("v");
  expect(await Bun.file(process.env.TWILIO_TEST_CLI_LOG).exists()).toBe(false);
  await click("Open details");
  await waitFor("PRIVATE_MESSAGE_BODY");
  expect(frame()).toContain("Second line");
  expect(frame()).toContain("READ ONLY");
  await key("ESCAPE"); expect(frame()).toContain("ACTIVITY");
  await key("ARROW_DOWN"); await key("RETURN");
  await waitFor("Duration (seconds): 45");
  await click("Webhook exchanges"); await waitFor("<Response><Say>Hello</Say></Response>");
  expect(frame()).toContain("POST https://example.test/voice");
  await click("Errors & warnings"); await waitFor("ERROR 11200");
  expect(frame()).toContain("HTTP retrieval failure");
  await key("ESCAPE"); expect(frame()).toContain("ACTIVITY");
  const saved = await loadSettings();
  expect(saved.views[0]).toMatchObject({ name: "Campaign MTD", profiles: ["prod"], filter: "Campaign", calendarPreset: "mtd", unique: true, chartVisible: false, chartInterval: "weekly" });
  expect(saved.views[0].line.number).toBe("+15552220000");
} finally { await act(async () => ui.renderer.destroy()); }
`);
    const child = Bun.spawn([process.execPath, "run", script], { cwd: root + "/..", env: {
      ...process.env, PATH: `${dir}:${process.env.PATH}`, TWILIO_TUI_CACHE: cachePath, TWILIO_TUI_SETTINGS: settingsPath,
      TWILIO_TEST_CLI_LOG: logPath, TWILIO_CLI_PROFILE: "", TWILIO_CLI_PROFILES: "",
    }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: stdout + stderr }).toEqual({ code: 0, output: "" });
    const requests = (await Bun.file(logPath).text()).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(requests.map((request) => request[0])).toEqual(Object.keys(outputs));
    expect(requests.every((request) => request.at(-2) === "-p" && request.at(-1) === "prod")).toBe(true);
    expect(Buffer.from(await Bun.file(cachePath).arrayBuffer()).includes(Buffer.from("PRIVATE_MESSAGE_BODY"))).toBe(false);
    expect(await Bun.file(settingsPath).text()).not.toContain("PRIVATE_MESSAGE_BODY");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20_000);
