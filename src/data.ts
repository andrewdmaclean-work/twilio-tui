import { ApiHistoryImporter, apiHistoryBoundary, type ApiImportState } from "./api-backfill";
import { ExportJobFailed, type ExportStatus } from "./backfill";
import { TrafficStore } from "./storage";
import { parseSavedViews, type SavedView } from "./views";
import { detailCommand, parseCallDiagnostics, parseEventDetail, parseWebhookExchanges, type DetailMode } from "./event-detail";
import { coverageAt, estimateDownloadMinutes, mergeRanges, missingDownloadDays, savedSnapshot, type DayRange } from "./coverage";
import {
  buildDashboard,
  dayKey,
  shiftDay,
  validDay,
  type DashboardData,
  type Period,
  type ProfileError,
  type ProfileEvents,
  type TimeZoneMode,
  type TrafficEvent,
  type ActivityEvent,
} from "./aggregate";

export * from "./aggregate";

type TwilioRecord = Record<string, unknown>;

function optionValue(name: string): string | undefined {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseProfiles(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((name) => name.trim()).filter(Boolean))];
}

const profileArgument = optionValue("--profiles")
  ?? optionValue("--profile")
  ?? process.env.TWILIO_CLI_PROFILES
  ?? process.env.TWILIO_CLI_PROFILE;

export const selectedProfiles = parseProfiles(profileArgument);
export function accountLabelFor(profiles: string[]): string {
  return profiles.length
    ? profiles.join(", ")
    : process.env.TWILIO_ACCOUNT_SID ?? "Active Twilio CLI account";
}

export type CliProfile = { id: string; accountSid?: string; active?: boolean; disconnected?: boolean };

export type HistorySettings = { startDay?: string; endDay?: string; intervalMinutes?: number; profiles?: string[] };
export type Settings = { profiles: string[]; focus: string | null; filter: string; excluded: string[]; importPaused?: boolean; history?: HistorySettings; views?: SavedView[] };

const settingsPath = process.env.TWILIO_TUI_SETTINGS ?? `${import.meta.dir}/../.twilio-tui.json`;
const legacySettingsPath = `${import.meta.dir}/../.twilio-traffic-pulse.json`;

export async function loadSettings(): Promise<Settings> {
  for (const path of process.env.TWILIO_TUI_SETTINGS ? [settingsPath] : [settingsPath, legacySettingsPath]) {
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) continue;
      const value: unknown = JSON.parse(await file.text());
      if (!isRecord(value)) continue;
      const profiles = Array.isArray(value.profiles)
        ? parseProfiles(value.profiles.filter((name): name is string => typeof name === "string").join(","))
        : [];
      const excluded = Array.isArray(value.excluded) ? value.excluded.filter((entry): entry is string => typeof entry === "string") : [];
      return {
        profiles,
        focus: typeof value.focus === "string" ? value.focus : null,
        filter: typeof value.filter === "string" ? value.filter : "",
        excluded,
        views: parseSavedViews(value.views),
        importPaused: value.importPaused !== false,
        history: isRecord(value.history) ? {
          startDay: typeof value.history.startDay === "string" && validDay(value.history.startDay) ? value.history.startDay : undefined,
          endDay: typeof value.history.endDay === "string" && validDay(value.history.endDay) ? value.history.endDay : undefined,
          intervalMinutes: [1, 5, 10, 30].includes(Number(value.history.intervalMinutes)) ? Number(value.history.intervalMinutes) : 10,
          profiles: Array.isArray(value.history.profiles) ? value.history.profiles.filter((id): id is string => typeof id === "string") : undefined,
        } : undefined,
      };
    } catch {
      // Fall through to defaults on unreadable settings.
    }
  }
  return { profiles: [], focus: null, filter: "", excluded: [], importPaused: true };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await Bun.write(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function profilesFromJson(value: unknown): CliProfile[] {
  const found: CliProfile[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) return;

    const id = node.id ?? node.name ?? node.profileId ?? node.profile;
    if (typeof id === "string") {
      const accountSid = node.accountSid ?? node.accountSID ?? node.sid;
      const active = node.active === true || node.active === "true";
      found.push({ id, ...(typeof accountSid === "string" ? { accountSid } : {}), active });
      return;
    }

    for (const key of ["profiles", "data", "items", "instances"]) visit(node[key]);
  };
  visit(value);
  return found;
}

export function profilesFromTable(output: string): CliProfile[] {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, "");
  return clean.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\S+)\s+(AC\S+)\s+(true|false)\s*$/i);
    return match ? [{ id: match[1]!, accountSid: match[2]!, active: match[3]!.toLowerCase() === "true" }] : [];
  });
}

type CliResult = { stdout: string; stderr: string; exitCode: number };

async function runCli(args: string[], { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }): Promise<CliResult> {
  signal?.throwIfAborted();
  const child = Bun.spawn(["twilio", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let rejectRequest: (reason: unknown) => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { rejectRequest = reject; });
  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    rejectRequest(new Error(`Twilio CLI timed out after ${Math.round(timeoutMs / 1000)}s (${args[0]})`));
  }, timeoutMs);
  const abort = () => {
    child.kill("SIGKILL");
    rejectRequest(signal?.reason ?? new Error("Request cancelled"));
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
      interrupted,
    ]);
    signal?.throwIfAborted();
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function cliError(result: CliResult, fallback: string): Error {
  const detail = result.stderr.replace(/^.*(update available|twil\.io\/cli).*$/gim, "").trim()
    || result.stdout.trim()
    || fallback;
  return new Error(detail.split("\n").slice(-3).join(" "));
}

/** Fetch only the opened record. Details and webhook bodies never enter the traffic cache. */
async function readDetail(event: ActivityEvent, mode: DetailMode, signal?: AbortSignal): Promise<unknown> {
  const result = await runCli(detailCommand(event, mode), { timeoutMs: 30_000, signal });
  if (result.exitCode !== 0) throw cliError({ ...result, stdout: "" }, "Twilio could not read this record. It may be unavailable or your profile may lack access.");
  try { return JSON.parse(result.stdout); }
  catch { throw new Error("Twilio CLI did not return valid JSON for this record"); }
}

export async function fetchEventDetail(event: ActivityEvent, signal?: AbortSignal) {
  return parseEventDetail(await readDetail(event, "detail", signal), event);
}

export async function fetchCallExchanges(event: ActivityEvent, signal?: AbortSignal) {
  return parseWebhookExchanges(await readDetail(event, "webhooks", signal));
}

export async function fetchCallDiagnostics(event: ActivityEvent, signal?: AbortSignal) {
  return parseCallDiagnostics(await readDetail(event, "diagnostics", signal));
}

export async function listCliProfiles(): Promise<CliProfile[]> {
  const jsonResult = await runCli(["profiles:list", "-o", "json"], { timeoutMs: 30_000 });
  if (jsonResult.exitCode === 0) {
    try {
      const profiles = profilesFromJson(JSON.parse(jsonResult.stdout));
      if (profiles.length) return profiles;
    } catch {
      // Older CLI versions may not support JSON output for profile management.
    }
  }

  const tableResult = await runCli(["profiles:list"], { timeoutMs: 30_000 });
  if (tableResult.exitCode !== 0) throw cliError(tableResult, "Could not list Twilio CLI profiles.");
  return profilesFromTable(tableResult.stdout);
}

function isRecord(value: unknown): value is TwilioRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCliTsv(output: string, required: string[] = ["sid", "direction", "to"]): TwilioRecord[] {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, "").replace(/^﻿/, "").trim();
  const lines = clean.split(/\r?\n/).filter((line) => line.length > 0);
  const canonicalHeader = (header: string) => {
    const key = header.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const known: Record<string, string> = {
      sid: "sid",
      to: "to",
      direction: "direction",
      status: "status",
      datesent: "dateSent",
      datecreated: "dateCreated",
      starttime: "startTime",
      startdate: "startDate",
      from: "from",
      parentcallsid: "parentCallSid",
      phonenumber: "phoneNumber",
      friendlyname: "friendlyName",
    };
    return known[key] ?? header.trim();
  };
  const headerIndex = lines.findIndex((line) => {
    const columns = line.split("\t").map(canonicalHeader);
    return required.every((column) => columns.includes(column));
  });
  if (headerIndex < 0) {
    // An empty result set prints nothing at all.
    if (!lines.some((line) => !/update available|twil\.io\/cli/i.test(line))) return [];
    throw new Error("Twilio CLI output did not contain the expected TSV columns. Run the command with `-o tsv` to inspect its output format.");
  }

  const headers = lines[headerIndex]!.split("\t").map(canonicalHeader);
  return lines.slice(headerIndex + 1).flatMap((line) => {
    const values = line.split("\t");
    if (values.every((value) => value.trim() === "")) return [];
    return [Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ""]))];
  });
}

function readTimestamp(record: TwilioRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string" || !value) continue;
    const time = new Date(value).getTime();
    if (!Number.isNaN(time)) return time;
  }
  return null;
}

function text(record: TwilioRecord, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function messageDirection(record: TwilioRecord): "in" | "out" {
  const direction = text(record, "direction").toLowerCase();
  if (direction) return direction.startsWith("inbound") ? "in" : "out";
  return text(record, "status").toLowerCase() === "received" ? "in" : "out";
}

/** Converts CLI records to traffic events in both directions. */
export function toEvents(records: TwilioRecord[], kind: TrafficEvent["kind"]): TrafficEvent[] {
  const timeKeys = kind === "message" ? ["dateSent", "dateCreated"] : ["startTime", "dateCreated"];
  return records.flatMap((record) => {
    const time = readTimestamp(record, timeKeys);
    if (time === null) return [];
    const direction = kind === "message"
      ? messageDirection(record)
      : text(record, "direction").toLowerCase() === "inbound" ? "in" : "out";
    const from = text(record, "from") || "Unknown";
    const to = text(record, "to") || "Unknown";
    const sid = text(record, "sid") || `${kind}:${time}:${from}:${to}`;
    const parent = text(record, "parentCallSid");
    return [{ sid, time, kind, direction, from, to, ...(parent ? { parent } : {}) }];
  });
}

type ProfileCache = {
  /** Earliest UTC day fully loaded. */
  coveredFrom: string | null;
  /** UTC day of the most recent successful fetch. */
  fetchedThrough: string | null;
  events: Map<string, TrafficEvent>;
  names?: Record<string, string>;
  owned?: string[];
  namesFetchedAt?: number;
  updatedAt?: number;
  coverageRanges?: DayRange[];
};

const cache = new Map<string, ProfileCache>();
const configuredCachePath = process.env.TWILIO_TUI_CACHE;
const legacyCachePath = configuredCachePath?.endsWith(".json") ? configuredCachePath : `${import.meta.dir}/../.twilio-tui-cache.json`;
const cachePath = configuredCachePath
  ? configuredCachePath.replace(/\.json$/, ".sqlite")
  : `${import.meta.dir}/../.twilio-tui.sqlite`;
let hydration: Promise<void> | undefined;
let store: TrafficStore | undefined;
const pendingEvents = new Map<string, Map<string, TrafficEvent>>();
const profileVersions = new Map<string, number>();

/** Keep missing CLI profiles visible so users can deselect or forget them. */
export function accountChoices(available: CliProfile[], selected: string[], saved: string[]): CliProfile[] {
  const known = new Set(available.map((profile) => profile.id));
  return [...available, ...[...new Set([...selected, ...saved])].filter((id) => id && !known.has(id))
    .map((id) => ({ id, disconnected: true }))];
}

export function savedAccounts(): string[] { return [...cache.keys()]; }

export function accountDownloadStatus(id: string): { from: string | null; through: string | null; nextDay?: string } {
  const entry = cache.get(id);
  const state = store?.getImportState<ApiImportState>(`api:${id}`);
  return { from: entry?.coveredFrom ?? null, through: entry?.fetchedThrough ?? null, nextDay: state?.nextDay };
}

export function downloadWindowPlan(profiles: string[], range: DayRange, intervalMinutes = 10, now = Date.now()) {
  const today = dayKey(new Date(now), "utc");
  const boundary = apiHistoryBoundary(now);
  const accounts = profiles.map((id) => {
    const entry = cache.get(id);
    const accountStart = store?.getImportState<ApiImportState>(`api:${id}`)?.accountStart;
    const earliest = accountStart && accountStart > boundary ? accountStart : boundary;
    return { id, ...missingDownloadDays(entry ? savedSnapshot(entry) : { ranges: [] }, range, earliest, today) };
  });
  const days = accounts.reduce((sum, account) => sum + account.days.length, 0);
  const wait = Math.max(0, (store?.getImportState<{ nextPullAt: number }>("@api-schedule")?.nextPullAt ?? 0) - now) / 60_000;
  return { accounts, days, minutes: estimateDownloadMinutes(days, intervalMinutes, wait),
    unavailable: accounts.reduce((sum, account) => sum + account.unavailable, 0),
    open: accounts.reduce((sum, account) => sum + account.open, 0) };
}

export function forgetAccount(id: string): void {
  store?.forgetProfile(id);
  profileVersions.set(id, (profileVersions.get(id) ?? 0) + 1);
  cache.delete(id);
  pendingEvents.delete(id);
}

/** Hydrate once and migrate JSON without deleting the original file. */
export function loadSavedCache(): Promise<void> {
  return hydration ??= (async () => {
    store = new TrafficStore(cachePath);
    const legacy = Bun.file(legacyCachePath);
    let migrationError: unknown;
    try {
      if (await legacy.exists()) store.importLegacy(await legacy.json());
    } catch (reason) { migrationError = reason; }
    for (const entry of store.load(false)) {
      cache.set(entry.id, { ...entry, events: new Map(entry.events.map((event) => [event.sid, event])) });
    }
    if (migrationError) throw migrationError;
  })();
}

async function persistCache(): Promise<void> {
  store ??= new TrafficStore(cachePath);
  store.save([...cache].map(([id, entry]) => ({
    id, ...entry, events: [...(pendingEvents.get(id)?.values() ?? [])],
  })));
  pendingEvents.clear();
  for (const entry of cache.values()) entry.events.clear();
}

function sourceFromCache(profile: string | undefined, entry: ProfileCache, from: string, through: string): ProfileEvents {
  const start = Date.parse(from), end = Date.parse(through);
  const events = new Map((store?.events(profile ?? "", start, end) ?? []).map((event) => [event.sid, event]));
  for (const event of entry.events.values()) if (event.time >= start && event.time < end) events.set(event.sid, event);
  return { profile, events: [...events.values()], names: entry.names, owned: entry.owned, coverage: savedSnapshot(entry) };
}

export function savedCoverage(profiles: string[]): string | null {
  const entries = (profiles.length ? profiles : [""]).map((id) => cache.get(id));
  if (entries.some((entry) => !entry?.coveredFrom)) return null;
  return entries.map((entry) => entry!.coveredFrom!).sort().at(-1)!;
}

export function savedUpdatedAt(profiles: string[]): Date | null {
  const times = (profiles.length ? profiles : [""]).map((id) => cache.get(id)?.updatedAt ?? 0);
  return times.every(Boolean) ? new Date(Math.min(...times)) : null;
}

async function listTraffic(
  profile: string | undefined,
  after: string,
  before: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
  exactDay = false,
): Promise<TrafficEvent[]> {
  const profileArgs = profile ? ["-p", profile] : [];
  const run = async (args: string[], kind: TrafficEvent["kind"]) => {
    const result = await runCli([...args, "-o", "tsv", ...profileArgs], { timeoutMs, signal });
    if (result.exitCode !== 0) throw cliError(result, `Twilio CLI exited with code ${result.exitCode}`);
    return toEvents(parseCliTsv(result.stdout), kind);
  };
  const [messages, calls] = await Promise.all([
    run([
      "api:core:messages:list",
      exactDay ? "--date-sent" : "--date-sent-after", after,
      ...(!exactDay && before ? ["--date-sent-before", before] : []),
      "--no-limit",
      "--page-size", "1000",
      "--properties", "sid,from,to,direction,status,dateSent,dateCreated",
    ], "message"),
    run([
      "api:core:calls:list",
      exactDay ? "--start-time" : "--start-time-after", after,
      ...(!exactDay && before ? ["--start-time-before", before] : []),
      "--no-limit",
      "--page-size", "1000",
      "--properties", "sid,from,to,direction,parentCallSid,startTime,dateCreated",
    ], "call"),
  ]);
  return [...messages, ...calls];
}

const namesMaxAge = 10 * 60_000;

/** Friendly names change rarely, so they are refreshed every ten minutes rather than every minute. */
async function listOwnedNumbers(profile: string | undefined, signal?: AbortSignal): Promise<{ names: Record<string, string>; owned: string[] }> {
  const result = await runCli([
    "api:core:incoming-phone-numbers:list",
    "--no-limit",
    "--properties", "sid,phoneNumber,friendlyName",
    "-o", "tsv",
    ...(profile ? ["-p", profile] : []),
  ], { timeoutMs: 60_000, signal });
  if (result.exitCode !== 0) throw cliError(result, "Could not list phone numbers.");
  const records = parseCliTsv(result.stdout, ["sid", "phoneNumber"]);
  return { names: namesFromRecords(records), owned: records.map((record) => text(record, "phoneNumber")).filter(Boolean) };
}

export function namesFromRecords(records: TwilioRecord[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const record of records) {
    const number = typeof record.phoneNumber === "string" ? record.phoneNumber : "";
    const name = typeof record.friendlyName === "string" ? record.friendlyName.trim() : "";
    // Twilio defaults the friendly name to the formatted number; only keep real labels.
    if (number && name && name.replace(/\D/g, "") !== number.replace(/\D/g, "") && /[a-z]/i.test(name)) names[number] = name;
  }
  return names;
}

/**
 * Loads inbound events for one profile from `from` (UTC day) through now.
 * Days already in the cache are not downloaded again; only the gap before the
 * cached range and the days since the last refresh are requested.
 */
async function loadProfile(profile: string | undefined, from: string, today: string, signal?: AbortSignal): Promise<ProfileEvents> {
  const id = profile ?? "";
  const version = profileVersions.get(id) ?? 0;
  const existing = cache.get(id);
  const previousCoverage = existing ? savedSnapshot(existing).ranges : [];
  const entry: ProfileCache = existing ? { ...existing, events: new Map(existing.events) } : { coveredFrom: null, fetchedThrough: null, events: new Map() };
  const names = !entry.namesFetchedAt || Date.now() - entry.namesFetchedAt > namesMaxAge
    ? listOwnedNumbers(profile, signal).then((found) => {
      entry.names = found.names;
      entry.owned = found.owned;
      entry.namesFetchedAt = Date.now();
    }, () => {
      // Names are optional; keep counting traffic if the number list is unavailable.
      entry.namesFetchedAt = Date.now();
    })
    : Promise.resolve();
  const merge = (events: TrafficEvent[]) => {
    for (const event of events) {
      entry.events.set(event.sid, event);
    }
  };
  let fetchedFrom = from;

  if (!entry.coveredFrom || !entry.fetchedThrough) {
    merge(await listTraffic(profile, from, undefined, 300_000, signal));
    entry.coveredFrom = entry.coveredFrom && entry.coveredFrom < from ? entry.coveredFrom : from;
  } else {
    // Re-read the previous day too, so late-arriving records near midnight are picked up.
    const recentFrom = shiftDay(entry.fetchedThrough, -1);
    fetchedFrom = from < entry.coveredFrom ? from : recentFrom;
    const [older, recent] = await Promise.all([
      from < entry.coveredFrom ? listTraffic(profile, from, entry.coveredFrom, 300_000, signal) : Promise.resolve([]),
      listTraffic(profile, recentFrom, undefined, 60_000, signal),
    ]);
    merge(older);
    merge(recent);
    if (from < entry.coveredFrom) entry.coveredFrom = from;
  }
  await names;
  signal?.throwIfAborted();
  if ((profileVersions.get(id) ?? 0) !== version) throw new Error("Account was removed while loading");
  // An older day may have finished downloading while the recent refresh was in flight.
  const importedFrom = cache.get(id)?.coveredFrom;
  if (importedFrom && importedFrom < entry.coveredFrom!) entry.coveredFrom = importedFrom;
  pendingEvents.set(id, new Map([...(pendingEvents.get(id) ?? []), ...entry.events]));
  entry.fetchedThrough = today;
  entry.updatedAt = Date.now();
  entry.coverageRanges = mergeRanges([...previousCoverage, ...(cache.get(id)?.coverageRanges ?? []), { from: fetchedFrom, through: shiftDay(today, -1) }]);
  cache.set(id, entry);
  return sourceFromCache(profile, entry, from, shiftDay(today, 2));
}

export type LoadedSources = { sources: ProfileEvents[]; errors: ProfileError[]; storageError?: string };

/** Loads every profile's inbound events (cached where possible). Filtering and bucketing happen in the UI. */
export async function fetchSources(period: Period, profiles: string[], { signal }: { signal?: AbortSignal } = {}): Promise<LoadedSources> {
  await loadSavedCache().catch(() => {});
  const today = dayKey(new Date(), "utc");
  // Keep automatic refreshes bounded. Older dates are controlled on Downloads,
  // independently of the dashboard's chosen window.
  const from = shiftDay(today, -60);
  const ids = profiles.length ? profiles : [undefined];

  const settled = await Promise.allSettled(ids.map((profile) => loadProfile(profile, from, today, signal)));
  signal?.throwIfAborted();

  const sources: ProfileEvents[] = [];
  const errors: ProfileError[] = [];
  settled.forEach((result, index) => {
    const profile = ids[index];
    if (result.status === "fulfilled") sources.push(result.value);
    else {
      errors.push({ profile, message: result.reason instanceof Error ? result.reason.message : String(result.reason) });
      const saved = cache.get(profile ?? "");
      sources.push(saved ? sourceFromCache(profile, saved, shiftDay(today, -(period * 2)), shiftDay(today, 2)) : { profile, events: [], coverage: { ranges: [] } });
    }
  });
  if (errors.length === ids.length && !sources.some((source) => source.events.length || source.coverage?.ranges.length)) {
    throw new Error(errors.map((error) => `${error.profile ?? "active"}: ${error.message}`).join(" · "));
  }
  let storageError: string | undefined;
  try { await persistCache(); } catch (reason) { storageError = `Could not save traffic: ${reason instanceof Error ? reason.message : String(reason)}`; }
  const displayFrom = shiftDay(today, -(period * 2));
  const displayed = sources.map((source) => {
    const entry = cache.get(source.profile ?? "");
    return entry ? sourceFromCache(source.profile, entry, displayFrom, shiftDay(today, 2)) : source;
  });
  return { sources: displayed, errors, storageError };
}

/** Returns cached events when every profile is already loaded far enough back, so range changes redraw instantly. */
export function cachedSources(period: Period, profiles: string[], now = new Date(), allowPartial = false): ProfileEvents[] | null {
  const from = shiftDay(dayKey(now, "utc"), -(period * 2));
  const ids = profiles.length ? profiles : [undefined];
  const sources: ProfileEvents[] = [];
  for (const profile of ids) {
    const entry = cache.get(profile ?? "");
    if (!entry) {
      if (allowPartial) { sources.push({ profile, events: [], coverage: { ranges: [] } }); continue; }
      return null;
    }
    if (!allowPartial && (!entry.coveredFrom || entry.coveredFrom > from)) return null;
    sources.push(sourceFromCache(profile, entry, from, shiftDay(dayKey(now, "utc"), 2)));
  }
  return sources.length ? sources : null;
}

export async function fetchDashboard(
  period: Period,
  profiles: string[] = selectedProfiles,
  { timeZone = "utc", filter = "", excluded = [], signal }: { timeZone?: TimeZoneMode; filter?: string; excluded?: string[]; signal?: AbortSignal } = {},
): Promise<DashboardData> {
  const { sources, errors } = await fetchSources(period, profiles, { signal });
  return buildDashboard(sources, period, timeZone, { errors, filter, excluded });
}

export function clearCache(): void {
  // Force a recent reload while preserving the historical archive and import checkpoints.
  for (const entry of cache.values()) { entry.fetchedThrough = null; entry.namesFetchedAt = 0; }
}

export function exportJobReady(value: TwilioRecord): boolean {
  const details = value.details;
  if (!Array.isArray(details) || !details.length) return false;
  const statuses = details.map((detail) => isRecord(detail) ? String(detail.status).replace(/[^a-z]/gi, "").toLowerCase() : "");
  if (statuses.some((status) => ["failed", "deletedbyuserrequest"].includes(status))) throw new ExportJobFailed("Twilio export failed; scheduling a replacement");
  return statuses.every((status) => ["completed", "completedemptyrecords"].includes(status));
}

/** Empty exports may have no S3 object; only Twilio's explicit status proves zero records. */
export function exportJobStatus(value: TwilioRecord): ExportStatus {
  const ready = exportJobReady(value);
  const emptyDays = Array.isArray(value.details) ? value.details.flatMap((detail) => {
    if (!isRecord(detail) || String(detail.status).replace(/[^a-z]/gi, "").toLowerCase() !== "completedemptyrecords") return [];
    return Array.isArray(detail.days) ? detail.days.filter((day): day is string => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)) : [];
  }) : [];
  return { ready, emptyDays };
}

export function exportRecord(record: TwilioRecord, kind: TrafficEvent["kind"]): TrafficEvent {
  const normalized = { ...record, dateSent: record.date_sent ?? record.dateSent, dateCreated: record.date_created ?? record.dateCreated,
    startTime: record.start_time ?? record.startTime, parentCallSid: record.parent_call_sid ?? record.parentCallSid };
  const event = toEvents([normalized], kind)[0];
  if (!event || typeof record.sid !== "string") throw new Error("Export contains an invalid traffic record; day was not marked complete");
  return event;
}

export async function downloadExport(url: string, kind: TrafficEvent["kind"], signal: AbortSignal): Promise<TrafficEvent[]> {
  if (new URL(url).protocol !== "https:") throw new Error("Export download URL must use HTTPS");
  const timeout = AbortSignal.timeout(300_000);
  const response = await fetch(url, { signal: AbortSignal.any([signal, timeout]) });
  if (!response.ok) {
    const errorText = await response.text();
    const code = errorText.match(/<Code>([a-zA-Z0-9_]+)<\/Code>/)?.[1];
    throw new Error(`Export download failed (${response.status}${code ? ` ${code}` : ""})`);
  }
  if (!response.body) throw new Error("Export download returned no body");
  const reader = response.body.getReader();
  let first = await reader.read();
  if (first.done) return [];
  while (first.value.byteLength < 2) {
    const next = await reader.read();
    if (next.done) break;
    const joined: Uint8Array<ArrayBuffer> = new Uint8Array(first.value.byteLength + next.value.byteLength);
    joined.set(first.value);
    joined.set(next.value, first.value.byteLength);
    first = { done: false, value: joined };
  }
  const prefix = first.value;
  const stream = new ReadableStream<BufferSource>({
    start(controller) { controller.enqueue(new Uint8Array(prefix)); },
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) controller.close(); else controller.enqueue(new Uint8Array(chunk.value));
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  const binary: ReadableStream<BufferSource> = (prefix[0] === 0x1f && prefix[1] === 0x8b ? stream.pipeThrough(new DecompressionStream("gzip")) : stream);
  const decoded = binary.pipeThrough(new TextDecoderStream());
  const textReader = decoded.getReader();
  const events: TrafficEvent[] = [];
  let pending = "";
  const parse = (line: string) => {
    if (!line.trim()) return;
    const value: unknown = JSON.parse(line);
    if (!isRecord(value)) throw new Error("Invalid export record");
    events.push(exportRecord(value, kind));
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await textReader.read();
      if (chunk.done) break;
      pending += chunk.value;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    }
    parse(pending);
  } finally { await textReader.cancel(); }
  return events;
}

export function createHistoryImporter(profiles: string[], options: HistorySettings = {}): ApiHistoryImporter {
  const versions = new Map((profiles.length ? profiles : [""]).map((id) => [id, profileVersions.get(id) ?? 0]));
  const checkVersion = (id: string) => {
    if ((profileVersions.get(id) ?? 0) !== versions.get(id)) throw new Error("Account was removed during download");
  };
  return new ApiHistoryImporter({
    getState: (id) => store?.getImportState<ApiImportState>(`api:${id}`) ?? null,
    saveState: (id, state) => { checkVersion(id); if (!store) throw new Error("History database is unavailable"); store.setImportState(`api:${id}`, state); },
    coverage: (id) => cache.get(id)?.coveredFrom ?? null,
    hasDay: (id, day) => {
      const entry = cache.get(id);
      return !!entry && coverageAt(savedSnapshot(entry), Date.parse(day), Date.parse(shiftDay(day, 1))) === "complete";
    },
    accountStart: async (profile, signal) => {
      const result = await runCli(["api:core:usage:records:all-time:list", "--category", "totalprice", "--no-include-subaccounts", "--limit", "1", "--properties", "startDate", "-o", "tsv", ...(profile ? ["-p", profile] : [])], { timeoutMs: 30_000, signal });
      if (result.exitCode !== 0) throw new Error(`History start (${profile ?? "active"}): ${cliError(result, "Cannot read account usage").message}`);
      return historyStartFromUsage(result.stdout);
    },
    fetchDay: async (profile, day, signal) => {
      const found = await listTraffic(profile, day, undefined, 300_000, signal, true);
      const start = Date.parse(`${day}T00:00:00Z`), end = Date.parse(`${shiftDay(day, 1)}T00:00:00Z`);
      return found.filter((event) => event.time >= start && event.time < end);
    },
    commit: (id, day, events, state) => {
      checkVersion(id);
      if (!store) throw new Error("History database is unavailable");
      const entry = cache.get(id) ?? { coveredFrom: null, fetchedThrough: null, events: new Map<string, TrafficEvent>() };
      const coverageRanges = mergeRanges([...savedSnapshot(entry).ranges, { from: day, through: day }]);
      // A separate historical window must never claim that the gap to recent traffic is saved.
      const contiguous = entry.fetchedThrough ? coverageRanges.find((range) => range.through >= shiftDay(entry.fetchedThrough!, -1) && range.from <= entry.fetchedThrough!) : undefined;
      const coveredFrom = contiguous?.from ?? entry.coveredFrom;
      const committedEvents = [...(pendingEvents.get(id)?.values() ?? []), ...entry.events.values(), ...events];
      store.commitImport({ id, ...entry, coveredFrom, coverageRanges, events: committedEvents }, state, `api:${id}`);
      entry.coverageRanges = coverageRanges;
      entry.coveredFrom = coveredFrom;
      cache.set(id, entry);
    },
    nextPullAt: () => store?.getImportState<{ nextPullAt: number }>("@api-schedule")?.nextPullAt ?? 0,
    setNextPullAt: (nextPullAt) => { if (!store) throw new Error("History database is unavailable"); store.setImportState("@api-schedule", { nextPullAt }); },
  }, profiles, () => Date.now(), { startDay: options.startDay, endDay: options.endDay, intervalMs: (options.intervalMinutes ?? 10) * 60_000 });
}

/** Refuse an invalid boundary rather than mark unrequested dates as imported. */
export function historyStartFromUsage(output: string): string {
  const dates = parseCliTsv(output, ["startDate"]).map((record) => record.startDate)
    .filter((date): date is string => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)));
  if (!dates.length) throw new Error("No historical usage dates available for this account");
  return dates.sort()[0]!;
}
