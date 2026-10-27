import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { TrafficEvent } from "./aggregate";
import type { DayRange } from "./coverage";

export type SavedProfile = {
  id: string;
  coveredFrom: string | null;
  fetchedThrough: string | null;
  names?: Record<string, string>;
  owned?: string[];
  namesFetchedAt?: number;
  updatedAt?: number;
  coverageRanges?: DayRange[];
  events: TrafficEvent[];
};

/** Event rows and coverage are committed together, so interrupted saves cannot claim missing history. */
export class TrafficStore {
  private db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        profile TEXT NOT NULL, sid TEXT NOT NULL, time INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (profile, sid)
      );
      CREATE INDEX IF NOT EXISTS events_profile_time ON events(profile, time);
      CREATE TABLE IF NOT EXISTS import_state (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
    `);
  }

  load(includeEvents = true): SavedProfile[] {
    return this.db.query<{ id: string; metadata: string }, []>("SELECT id, metadata FROM profiles").all().map((row) => ({
      ...JSON.parse(row.metadata),
      id: row.id,
      events: includeEvents ? this.events(row.id) : [],
    }));
  }

  events(id: string, from = -Infinity, through = Infinity): TrafficEvent[] {
    return this.db.query<{ data: string }, [string, number, number]>("SELECT data FROM events WHERE profile = ? AND time >= ? AND time < ? ORDER BY time")
      .all(id, Number.isFinite(from) ? from : -8.64e15, Number.isFinite(through) ? through : 8.64e15).map((row) => JSON.parse(row.data));
  }

  /** Supply only fetched or changed events; existing history is retained. */
  save(profiles: SavedProfile[], reset = false): void {
    const metadata = this.db.query("INSERT INTO profiles (id, metadata) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET metadata = excluded.metadata");
    const event = this.db.query("INSERT INTO events (profile, sid, time, data) VALUES (?, ?, ?, ?) ON CONFLICT(profile, sid) DO UPDATE SET time = excluded.time, data = excluded.data");
    this.db.transaction(() => {
      if (reset) this.db.exec("DELETE FROM events; DELETE FROM profiles;");
      for (const profile of profiles) {
        const { id, events, ...details } = profile;
        metadata.run(id, JSON.stringify(details));
        for (const row of events) event.run(id, row.sid, row.time, JSON.stringify(row));
      }
    })();
  }

  /** Import only once, keeping any newer SQLite data if a legacy file remains. */
  importLegacy(value: unknown): void {
    if (this.db.query("SELECT name FROM migrations WHERE name = 'json-cache'").get()) return;
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("profiles" in value) || !Array.isArray(value.profiles)) throw new Error("Invalid saved traffic cache");
    const profiles = value.profiles as SavedProfile[];
    for (const profile of profiles) {
      if (!profile || typeof profile.id !== "string" || typeof profile.coveredFrom !== "string" || typeof profile.fetchedThrough !== "string" || !Array.isArray(profile.events)) throw new Error("Invalid saved profile");
      if (!profile.events.every((event) => event && typeof event.sid === "string" && Number.isFinite(event.time) && ["message", "call"].includes(event.kind) && ["in", "out"].includes(event.direction) && typeof event.from === "string" && typeof event.to === "string")) throw new Error("Invalid saved event");
    }
    this.db.transaction(() => {
      const existing = new Set(this.db.query<{ id: string }, []>("SELECT id FROM profiles").all().map((row) => row.id));
      this.save(profiles.filter((profile) => !existing.has(profile.id)));
      this.db.query("INSERT INTO migrations (name) VALUES ('json-cache')").run();
    })();
  }

  getImportState<T>(id: string): T | null {
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM import_state WHERE id = ?").get(id);
    return row ? JSON.parse(row.data) : null;
  }

  setImportState(id: string, value: unknown): void {
    this.db.query("INSERT INTO import_state (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(id, JSON.stringify(value));
  }

  forgetProfile(id: string): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM events WHERE profile = ?").run(id);
      this.db.query("DELETE FROM profiles WHERE id = ?").run(id);
      this.db.query("DELETE FROM import_state WHERE id = ? OR id = ?").run(id, `api:${id}`);
    })();
  }

  commitImport(profile: SavedProfile, state: unknown, stateId = profile.id): void {
    this.db.transaction(() => {
      this.save([profile]);
      this.setImportState(stateId, state);
    })();
  }

  close(): void { this.db.close(); }
}
