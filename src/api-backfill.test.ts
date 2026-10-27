import { describe, expect, test } from "bun:test";
import { ApiHistoryImporter, apiHistoryBoundary, type ApiImportBackend, type ApiImportState } from "./api-backfill";
import { readFileSync } from "node:fs";

function harness(profiles = ["production"]) {
  let now = Date.parse("2026-10-09T12:00:00Z");
  let nextPullAt = 0;
  const states = new Map<string, ApiImportState>();
  const coverage = new Map(profiles.map((id) => [id, "2026-08-10"]));
  const requested: string[] = [], saved: string[] = [];
  const backend: ApiImportBackend = {
    getState: (id) => structuredClone(states.get(id) ?? null),
    saveState: (id, state) => { states.set(id, structuredClone(state)); },
    coverage: (id) => coverage.get(id) ?? null,
    accountStart: async () => "2020-01-01",
    fetchDay: async (profile, day) => { requested.push(`${profile}:${day}`); return []; },
    commit: (id, day, _events, state) => { saved.push(`${id}:${day}`); states.set(id, state); coverage.set(id, day); },
    nextPullAt: () => nextPullAt,
    setNextPullAt: (time) => { nextPullAt = time; },
  };
  return { backend, states, coverage, requested, saved, importer: () => new ApiHistoryImporter(backend, profiles, () => now), advance: (ms: number) => { now += ms; } };
}
const signal = () => new AbortController().signal;

describe("read-only API history import", () => {
  test("window downloads fill only missing days, resume from saved coverage, and need no recent cache", async () => {
    const h = harness(["production", "staging"]);
    const covered = new Set(["production:2026-08-02", "production:2026-08-04"]);
    h.backend.hasDay = (id, day) => covered.has(`${id}:${day}`);
    h.backend.coverage = () => null;
    const commit = h.backend.commit;
    h.backend.commit = (id, day, events, state) => { commit(id, day, events, state); covered.add(`${id}:${day}`); };
    let now = Date.parse("2026-10-09T12:00:00Z");
    const importer = () => new ApiHistoryImporter(h.backend, ["production"], () => now,
      { startDay: "2026-08-01", endDay: "2026-08-04", intervalMs: 60_000 });
    expect((await importer().step(signal())).changed).toBe(true);
    expect(h.requested).toEqual(["production:2026-08-03"]);
    expect((await importer().step(signal())).phase).toBe("waiting");
    now += 60_000;
    await importer().step(signal());
    expect(h.requested).toEqual(["production:2026-08-03", "production:2026-08-01"]);
    const progress = await importer().step(signal());
    expect(progress.phase).toBe("complete");
    expect(progress.completed).toBe(4);
    expect(progress.total).toBe(4);
    expect(h.coverage.get("staging")).toBe("2026-08-10");
  });

  test("window downloads exclude the current UTC day and stop at API retention", async () => {
    const h = harness();
    h.backend.hasDay = () => false;
    const importer = new ApiHistoryImporter(h.backend, ["production"], () => Date.parse("2026-10-09T12:00:00Z"),
      { startDay: "2020-01-01", endDay: "2026-10-09" });
    await importer.step(signal());
    expect(h.requested).toEqual(["production:2026-10-08"]);
    expect(h.states.get("production")?.startDay).toBe("2025-09-10");
    expect(h.states.get("production")?.initialDay).toBe("2026-10-08");
  });
  test("honours selected accounts, oldest date and pacing, and can extend a finished download", async () => {
    const h = harness(["production", "staging"]);
    const until = (startDay: string) => new ApiHistoryImporter(h.backend, ["staging"],
      () => Date.parse("2026-10-09T12:00:00Z") + offset, { startDay, intervalMs: 60_000 });
    let offset = 0;
    expect((await until("2026-08-09").step(signal())).changed).toBe(true);
    expect(h.requested).toEqual(["staging:2026-08-09"]);
    expect((await until("2026-08-09").step(signal())).phase).toBe("complete");
    expect((await until("2026-08-08").step(signal())).phase).toBe("waiting");
    offset = 60_000;
    expect((await until("2026-08-08").step(signal())).changed).toBe(true);
    expect(h.requested).toEqual(["staging:2026-08-09", "staging:2026-08-08"]);
    expect(h.coverage.get("production")).toBe("2026-08-10");
    expect((await until("2026-08-08").step(signal())).phase).toBe("complete");
  });

  test("a wider target never goes before account creation", async () => {
    const h = harness();
    h.backend.accountStart = async () => "2026-08-09";
    const importer = () => new ApiHistoryImporter(h.backend, ["production"], () => Date.parse("2026-10-09T12:00:00Z"), { startDay: "2025-01-01" });
    await importer().step(signal());
    expect((await importer().step(signal())).phase).toBe("complete");
    expect(h.requested).toEqual(["production:2026-08-09"]);
  });
  test("imports one day and persists pacing across restarts", async () => {
    const h = harness(["production", "staging"]);
    const importer = h.importer();
    expect((await importer.step(signal())).changed).toBe(true);
    expect(h.requested).toEqual(["production:2026-08-09"]);
    expect((await h.importer().step(signal())).phase).toBe("waiting");
    expect(h.requested).toHaveLength(1);
    h.advance(600_000);
    await importer.step(signal());
    expect(h.requested).toEqual(["production:2026-08-09", "staging:2026-08-09"]);
  });

  test("limits history to retained dates and preserves older saved coverage", async () => {
    const h = harness();
    await h.importer().step(signal());
    expect(h.states.get("production")?.startDay).toBe("2025-09-10");
    h.coverage.set("production", "2020-01-01");
    expect((await h.importer().step(signal())).phase).toBe("complete");
    expect(h.coverage.get("production")).toBe("2020-01-01");
    expect(h.requested).toHaveLength(1);
  });

  test("failed pulls do not advance coverage or checkpoints", async () => {
    const h = harness();
    h.backend.fetchDay = async () => { throw new Error("429 rate limit"); };
    expect((await h.importer().step(signal())).phase).toBe("retrying");
    expect(h.coverage.get("production")).toBe("2026-08-10");
    expect(h.states.get("production")?.nextDay).toBe("2026-08-09");
    expect(h.saved).toHaveLength(0);
    h.advance(600_000);
    h.backend.fetchDay = async () => [];
    await h.importer().step(signal());
    expect(h.saved).toEqual(["production:2026-08-09"]);
  });

  test("pause during a pull prevents committing partial data", async () => {
    const h = harness();
    const controller = new AbortController();
    h.backend.fetchDay = async () => { controller.abort(); return []; };
    await expect(h.importer().step(controller.signal)).rejects.toThrow();
    expect(h.saved).toHaveLength(0);
  });

  test("stops at account history and moves the retention boundary over time", async () => {
    const h = harness();
    h.backend.accountStart = async () => "2026-08-09";
    await h.importer().step(signal());
    expect((await h.importer().step(signal())).phase).toBe("complete");
    expect(apiHistoryBoundary(Date.parse("2026-03-31T12:00:00Z"))).toBe("2025-03-01");
  });

  test("production importer cannot create export jobs", () => {
    const data = readFileSync(`${import.meta.dir}/data.ts`, "utf8");
    const factory = data.slice(data.indexOf("export function createHistoryImporter"));
    expect(factory).toContain("new ApiHistoryImporter");
    expect(factory).not.toContain("createJob");
    expect(data).not.toContain("api:bulkexports");
  });
});
