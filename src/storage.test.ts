import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrafficStore, type SavedProfile } from "./storage";
import type { TrafficEvent } from "./aggregate";

const event: TrafficEvent = { sid: "SM1", time: 1000, kind: "message", direction: "in", from: "+15550001", to: "+15550002" };
const profile = (id = "production", events = [event]): SavedProfile => ({
  id, coveredFrom: "2026-01-01", fetchedThrough: "2026-10-08", updatedAt: 2000,
  names: { "+15550002": "Support" }, owned: ["+15550002"], events,
});

describe("traffic storage", () => {
  test("sparse saved windows survive restart without marking the gap covered", () => {
    const store = new TrafficStore(":memory:");
    try {
      const coverageRanges = [{ from: "2025-10-01", through: "2025-10-03" }, { from: "2026-09-01", through: "2026-10-07" }];
      store.save([{ ...profile(), coveredFrom: "2026-09-01", coverageRanges }]);
      const saved = store.load(false)[0]!;
      expect(saved.coverageRanges).toEqual(coverageRanges);
      expect(saved.coveredFrom).toBe("2026-09-01");
    } finally { store.close(); }
  });
  test("forgetting an account removes its traffic and checkpoints while preserving other accounts", () => {
    const store = new TrafficStore(":memory:");
    try {
      store.save([profile("gone"), profile("keep")]);
      store.setImportState("gone", { nextDay: "2025-12-31" });
      store.setImportState("api:gone", { nextDay: "2025-12-31" });
      store.setImportState("api:keep", { nextDay: "2025-12-30" });
      store.forgetProfile("gone");
      expect(store.load()).toEqual([profile("keep")]);
      expect(store.events("gone")).toEqual([]);
      expect(store.getImportState("gone")).toBeNull();
      expect(store.getImportState("api:gone")).toBeNull();
      expect(store.getImportState<{ nextDay: string }>("api:keep")).toEqual({ nextDay: "2025-12-30" });
    } finally { store.close(); }
  });
  test("persists across restarts and keeps separate accounts and old events on incremental updates", () => {
    const directory = mkdtempSync(join(tmpdir(), "twilio-store-"));
    const path = join(directory, "traffic.sqlite");
    try {
      const store = new TrafficStore(path);
      store.save([profile(), profile("staging")]);
      store.save([profile("production", [{ ...event, sid: "SM2", time: 2000 }])]);
      store.save([profile("production", [{ ...event, direction: "out" }])]);
      store.close();
      const reopened = new TrafficStore(path);
      try {
        const records = reopened.load();
        expect(records.find((row) => row.id === "production")?.events).toEqual([{ ...event, direction: "out" }, { ...event, sid: "SM2", time: 2000 }]);
        expect(records.find((row) => row.id === "staging")?.events).toEqual([event]);
        expect(records[0]?.names).toEqual(profile().names);
        expect(statSync(path).mode & 0o777).toBe(0o600);
      } finally { reopened.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("imports JSON once without overwriting newer profiles", () => {
    const store = new TrafficStore(":memory:");
    try {
      store.save([profile("production", [{ ...event, direction: "out" }])]);
      store.importLegacy({ version: 1, profiles: [profile(), profile("staging")] });
      store.save([profile("staging", [{ ...event, sid: "SM2" }])]);
      store.importLegacy({ version: 1, profiles: [profile("third")] });
      const records = store.load();
      expect(records).toHaveLength(2);
      expect(records.find((row) => row.id === "production")?.events[0]?.direction).toBe("out");
      expect(records.find((row) => row.id === "staging")?.events).toHaveLength(2);
    } finally { store.close(); }
  });

  test("rolls back both events and coverage if a batch fails", () => {
    const store = new TrafficStore(":memory:");
    try {
      store.save([profile()]);
      const invalid = { ...event, sid: "SM2", time: null } as unknown as TrafficEvent;
      expect(() => store.save([{ ...profile(), coveredFrom: "2020-01-01", events: [invalid] }])).toThrow();
      expect(store.load()).toEqual([profile()]);
    } finally { store.close(); }
  });

  test("rejects invalid legacy data without partially importing it", () => {
    const store = new TrafficStore(":memory:");
    try {
      expect(() => store.importLegacy({ version: 1, profiles: [profile(), { id: "bad" }] })).toThrow();
      expect(store.load()).toEqual([]);
      store.importLegacy({ version: 1, profiles: [profile()] });
      expect(store.load()).toEqual([profile()]);
    } finally { store.close(); }
  });

  test("reads only the requested date interval without loading the whole archive", () => {
    const store = new TrafficStore(":memory:");
    try {
      store.save([profile("production", [{ ...event, time: 1000 }, { ...event, sid: "SM2", time: 2000 }, { ...event, sid: "SM3", time: 3000 }])]);
      expect(store.load(false)[0]?.events).toEqual([]);
      expect(store.events("production", 2000, 3000)).toEqual([{ ...event, sid: "SM2", time: 2000 }]);
    } finally { store.close(); }
  });

  test("commits imported events and resume checkpoint together, including on failure", () => {
    const store = new TrafficStore(":memory:");
    try {
      store.save([profile()]);
      store.setImportState("production", { nextDay: "2025-12-31" });
      const invalid = { ...event, sid: "bad", time: null } as unknown as TrafficEvent;
      expect(() => store.commitImport({ ...profile(), coveredFrom: "2025-12-31", events: [invalid] }, { nextDay: "2025-12-30" })).toThrow();
      expect(store.getImportState<{ nextDay: string }>("production")).toEqual({ nextDay: "2025-12-31" });
      expect(store.load()[0]?.coveredFrom).toBe("2026-01-01");
      store.commitImport({ ...profile(), coveredFrom: "2025-12-31", events: [{ ...event, sid: "SM2" }] }, { nextDay: "2025-12-30" });
      expect(store.load()[0]?.events).toHaveLength(2);
      expect(store.getImportState<{ nextDay: string }>("production")).toEqual({ nextDay: "2025-12-30" });
    } finally { store.close(); }
  });

  test("explicit cache reset replaces saved history atomically", () => {
    const store = new TrafficStore(":memory:");
    try {
      store.save([profile(), profile("staging")]);
      store.save([profile("new-account")], true);
      expect(store.load()).toEqual([profile("new-account")]);
    } finally { store.close(); }
  });
});
