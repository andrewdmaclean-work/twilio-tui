import { describe, expect, test } from "bun:test";
import { ExportJobFailed, HistoryImporter, type ImportBackend, type ImportState } from "./backfill";
import { downloadExport, exportJobReady, exportJobStatus, exportRecord, historyStartFromUsage } from "./data";
import type { TrafficEvent } from "./aggregate";

function harness(profiles = ["production"]) {
  let now = Date.parse("2026-10-08T12:00:00Z");
  const states = new Map<string, ImportState>();
  const coverage = new Map(profiles.map((id) => [id, "2026-10-06"]));
  let schedule: ReturnType<ImportBackend["getSchedule"]> = null;
  const created: string[] = [];
  const saved: string[] = [];
  const backend: ImportBackend = {
    getState: (id) => states.has(id) ? structuredClone(states.get(id)!) : null,
    saveState: (id, state) => { states.set(id, structuredClone(state)); },
    coverage: (id) => coverage.get(id) ?? null,
    accountStart: async () => "2026-10-01",
    createJob: async (profile, from, through, kind) => { created.push(`${profile}:${from}:${through}:${kind}`); return `JS${created.length}`; },
    jobReady: async () => true,
    download: async () => [],
    commit: (id, day, _events, state) => { saved.push(`${id}:${day}`); coverage.set(id, day); states.set(id, state); },
    getSchedule: () => schedule ? structuredClone(schedule) : null,
    saveSchedule: (value) => { schedule = structuredClone(value); },
  };
  return { backend, states, coverage, created, saved, importer: () => new HistoryImporter(backend, profiles, () => now), advance: (ms: number) => { now += ms; } };
}
const signal = () => new AbortController().signal;

describe("background history import", () => {
  test("imports older days serially and keeps pacing across restart", async () => {
    const h = harness(["production", "staging"]);
    const importer = h.importer();
    expect((await importer.step(signal())).day).toBe("2026-10-05");
    expect(h.saved).toEqual(["production:2026-10-05"]);
    expect(h.created).toHaveLength(2);
    expect((await h.importer().step(signal())).phase).toBe("waiting");
    expect(h.created).toHaveLength(2);
    h.advance(600_000);
    await importer.step(signal());
    expect(h.saved).toEqual(["production:2026-10-05", "staging:2026-10-05"]);
  });

  test("resumes pending export jobs without submitting duplicates", async () => {
    const h = harness();
    h.backend.jobReady = async () => false;
    await h.importer().step(signal());
    expect(h.created).toHaveLength(2);
    expect(h.saved).toHaveLength(0);
    h.backend.jobReady = async () => true;
    await h.importer().step(signal());
    expect(h.created).toHaveLength(2);
    expect(h.saved).toHaveLength(1);
  });

  test("failed download never advances saved coverage, retries reuse jobs", async () => {
    const h = harness();
    h.backend.download = async () => { throw new Error("connection dropped"); };
    const importer = h.importer();
    expect((await importer.step(signal())).phase).toBe("retrying");
    expect(h.coverage.get("production")).toBe("2026-10-06");
    expect(h.states.get("production")?.nextDay).toBe("2026-10-05");
    h.advance(30_000);
    h.backend.download = async () => [];
    await importer.step(signal());
    expect(h.created).toHaveLength(2);
    expect(h.saved).toHaveLength(1);
  });

  test("pause during download prevents commit and resume continues same day", async () => {
    const h = harness();
    const controller = new AbortController();
    h.backend.download = async () => { controller.abort(); return []; };
    await expect(h.importer().step(controller.signal)).rejects.toThrow();
    expect(h.saved).toHaveLength(0);
    h.backend.download = async () => [];
    await h.importer().step(signal());
    expect(h.saved).toHaveLength(1);
    expect(h.created).toHaveLength(2);
  });

  test("stops at account creation date and skips foreground-loaded history", async () => {
    const h = harness();
    h.backend.accountStart = async () => "2026-10-05";
    await h.importer().step(signal());
    expect((await h.importer().step(signal())).phase).toBe("complete");
    expect(h.created).toHaveLength(2);
    const other = harness();
    other.backend.jobReady = async () => false;
    await other.importer().step(signal());
    other.coverage.set("production", "2026-10-01");
    expect((await other.importer().step(signal())).phase).toBe("complete");
  });

  test("regenerates failed jobs and honours the shared daily budget", async () => {
    const h = harness();
    h.backend.jobReady = async () => { throw new ExportJobFailed("failed"); };
    await h.importer().step(signal());
    expect(h.states.get("production")?.jobs.Messages).toBeUndefined();
    h.backend.jobReady = async () => true;
    h.backend.saveSchedule({ nextBatchAt: 0, budgetDay: "2026-10-08", submitted: 300 });
    expect((await h.importer().step(signal())).message).toContain("budget");
    expect(h.created).toHaveLength(2);
    h.advance(86_400_000);
    await h.importer().step(signal());
    expect(h.created).toHaveLength(3);
    expect(h.saved).toHaveLength(1);
  });
});

describe("bulk export decoding", () => {
  test("accepts completed and empty jobs, rejects failed jobs", () => {
    expect(exportJobReady({ details: [{ status: "Completed" }, { status: "CompletedEmptyRecords" }] })).toBe(true);
    expect(exportJobReady({ details: [{ status: "COMPLETED" }, { status: "SUBMITTED" }] })).toBe(false);
    expect(() => exportJobReady({ details: [{ status: "Failed" }] })).toThrow();
  });

  test("normalizes archived call fields and drops message bodies", () => {
    const call = exportRecord({ sid: "CA1", start_time: "2020-01-01T00:00:00Z", parent_call_sid: "CA0", direction: "outbound-dial", from: "a", to: "b" }, "call");
    expect(call.parent).toBe("CA0");
    expect(call.time).toBe(Date.parse("2020-01-01T00:00:00Z"));
    expect(exportRecord({ sid: "SM1", date_created: "2020-01-01T00:00:00Z", body: "private", direction: "inbound", from: "a", to: "b" }, "message")).not.toHaveProperty("body");
    expect(() => exportRecord({ sid: "bad" }, "call")).toThrow();
  });

  test("streams a gzipped export containing thousands of calls", async () => {
    const originalFetch = globalThis.fetch;
    const rows = Array.from({ length: 10_000 }, (_, index) => JSON.stringify({ sid: `CA${index}`, start_time: "2020-01-01T00:00:00Z", direction: "inbound", from: "a", to: "b" })).join("\n");
    const compressed = Bun.gzipSync(new TextEncoder().encode(rows));
    globalThis.fetch = (async () => new Response(compressed)) as unknown as typeof fetch;
    try {
      const events = await downloadExport("https://example.com/export", "call", signal());
      expect(events).toHaveLength(10_000);
      expect(events.at(-1)?.sid).toBe("CA9999");
    } finally { globalThis.fetch = originalFetch; }
  });
});

describe("history start parsing", () => {
  test("reads the summary start date without account-details access", () => {
    expect(historyStartFromUsage("startDate\n2025-10-24\n")).toBe("2025-10-24");
    expect(historyStartFromUsage("startDate\n2025-10-24\n2020-01-01\n")).toBe("2020-01-01");
  });
  test("rejects missing or invalid dates", () => {
    expect(() => historyStartFromUsage("startDate\n")).toThrow();
    expect(() => historyStartFromUsage("startDate\ninvalid\n")).toThrow();
  });
});

test("reports progress before a pending startup request completes", async () => {
  const h = harness();
  let finish!: (day: string) => void;
  h.backend.accountStart = () => new Promise((resolve) => { finish = resolve; });
  const updates: string[] = [];
  const step = h.importer().step(signal(), (progress) => updates.push(progress.message));
  expect(updates).toEqual(["Reading history start date"]);
  expect(h.created).toHaveLength(0);
  finish("2026-10-01");
  await step;
  expect(updates).toContain("Submitting Messages export");
  expect(updates).toContain("Checking Calls export");
  expect(updates).toContain("Downloading Calls");
});

describe("weekly export batches", () => {
  test("reuses two jobs for all seven daily downloads, including after restart", async () => {
    const h = harness();
    h.backend.accountStart = async () => "2026-09-01";
    let polls = 0;
    h.backend.jobReady = async () => { polls++; return true; };
    await h.importer().step(signal());
    expect(h.created).toEqual([
      "production:2026-09-29:2026-10-05:Messages",
      "production:2026-09-29:2026-10-05:Calls",
    ]);
    expect(h.backend.getSchedule()?.submitted).toBe(14);
    expect(h.states.get("production")?.batch).toEqual({ from: "2026-09-29", through: "2026-10-05" });
    expect((await h.importer().step(signal())).message).toContain("Next download");
    for (let day = 0; day < 6; day++) {
      h.advance(600_000);
      await h.importer().step(signal());
    }
    expect(h.created).toHaveLength(2);
    expect(polls).toBe(2);
    expect(h.saved).toHaveLength(7);
    expect(h.states.get("production")?.jobs).toEqual({});
    expect(h.states.get("production")?.batch).toBeUndefined();
    h.advance(600_000);
    await h.importer().step(signal());
    expect(h.created).toHaveLength(4);
    expect(h.saved).toHaveLength(8);
  });

  test("keeps legacy single-day jobs until their day is saved", async () => {
    const h = harness();
    h.states.set("production", {
      startDay: "2026-09-01", initialDay: "2026-10-05", nextDay: "2026-10-05",
      jobs: { Messages: { sid: "old-message", createdAt: Date.parse("2026-10-08T12:00:00Z") }, Calls: { sid: "old-call", createdAt: Date.parse("2026-10-08T12:00:00Z") } },
    });
    await h.importer().step(signal());
    expect(h.created).toHaveLength(0);
    expect(h.saved).toEqual(["production:2026-10-05"]);
    h.advance(600_000);
    await h.importer().step(signal());
    expect(h.created[0]).toBe("production:2026-09-28:2026-10-04:Messages");
  });

  test("respects the oldest date and counts export days rather than jobs", async () => {
    const h = harness();
    h.backend.accountStart = async () => "2026-10-03";
    await h.importer().step(signal());
    expect(h.created[0]).toBe("production:2026-10-03:2026-10-05:Messages");
    expect(h.backend.getSchedule()?.submitted).toBe(6);
    const limited = harness();
    limited.backend.accountStart = async () => "2026-09-01";
    limited.backend.saveSchedule({ nextBatchAt: 0, budgetDay: "2026-10-08", submitted: 294 });
    expect((await limited.importer().step(signal())).message).toContain("budget");
    expect(limited.created).toHaveLength(0);
    expect(limited.backend.getSchedule()?.submitted).toBe(294);
  });

  test("skips foreground-loaded dates while keeping usable weekly jobs", async () => {
    const h = harness();
    h.backend.accountStart = async () => "2026-09-01";
    await h.importer().step(signal());
    h.coverage.set("production", "2026-10-02");
    h.advance(600_000);
    await h.importer().step(signal());
    expect(h.saved).toEqual(["production:2026-10-05", "production:2026-10-01"]);
    expect(h.created).toHaveLength(2);
  });
});

describe("confirmed empty export days", () => {
  test("advances empty days without requesting their missing S3 files", async () => {
    const h = harness();
    h.backend.jobReady = async () => ({ ready: true, emptyDays: ["2026-10-05"] });
    h.backend.download = async () => { throw new Error("404 NoSuchKey"); };
    expect((await h.importer().step(signal())).changed).toBe(true);
    expect(h.saved).toEqual(["production:2026-10-05"]);
  });

  test("refreshes previously cached ready flags to learn empty status", async () => {
    const h = harness();
    h.states.set("production", {
      startDay: "2026-10-01", initialDay: "2026-10-05", nextDay: "2026-10-05",
      jobs: { Messages: { sid: "old-message", createdAt: Date.parse("2026-10-08T12:00:00Z"), ready: true }, Calls: { sid: "old-call", createdAt: Date.parse("2026-10-08T12:00:00Z"), ready: true } },
    });
    let checked = 0;
    h.backend.jobReady = async () => { checked++; return { ready: true, emptyDays: ["2026-10-05"] }; };
    h.backend.download = async () => { throw new Error("must not download empty file"); };
    await h.importer().step(signal());
    expect(checked).toBe(2);
    expect(h.created).toHaveLength(0);
    expect(h.saved).toHaveLength(1);
  });

  test("skips only the empty days and resource that Twilio explicitly identifies", async () => {
    const h = harness();
    h.backend.jobReady = async (_profile, sid) => ({ ready: true, emptyDays: sid === "JS1" ? ["2026-10-05"] : ["2026-10-04"] });
    const downloaded: string[] = [];
    h.backend.download = async (_profile, day, kind) => { downloaded.push(`${day}:${kind}`); return []; };
    await h.importer().step(signal());
    expect(downloaded).toEqual(["2026-10-05:Calls"]);
    h.advance(600_000);
    await h.importer().step(signal());
    expect(downloaded).toEqual(["2026-10-05:Calls", "2026-10-04:Messages"]);
  });

  test("parses mixed weekly statuses without mistaking missing status for empty data", () => {
    expect(exportJobStatus({ details: [
      { status: "Completed", days: ["2026-10-05"] },
      { status: "CompletedEmptyRecords", days: ["2026-10-04"] },
    ] })).toEqual({ ready: true, emptyDays: ["2026-10-04"] });
    expect(exportJobStatus({ details: [{ status: "Completed" }] })).toEqual({ ready: true, emptyDays: [] });
    expect(exportJobStatus({ details: [] })).toEqual({ ready: false, emptyDays: [] });
  });
});
