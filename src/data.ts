import {
  buildDashboard,
  dayKey,
  shiftDay,
  type DashboardData,
  type Period,
  type ProfileError,
  type ProfileEvents,
  type TimeZoneMode,
  type TrafficEvent,
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

export type CliProfile = { id: string; accountSid?: string; active?: boolean };

export type Settings = { profiles: string[]; focus: string | null; filter: string; excluded: string[] };

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
      };
    } catch {
      // Fall through to defaults on unreadable settings.
    }
  }
  return { profiles: [], focus: null, filter: "", excluded: [] };
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
  const child = Bun.spawn(["twilio", ...args], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    signal?.throwIfAborted();
    if (timedOut) throw new Error(`Twilio CLI timed out after ${Math.round(timeoutMs / 1000)}s (twilio ${args[0]})`);
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
};

const cache = new Map<string, ProfileCache>();

async function listTraffic(
  profile: string | undefined,
  after: string,
  before: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
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
      "--date-sent-after", after,
      ...(before ? ["--date-sent-before", before] : []),
      "--no-limit",
      "--properties", "sid,from,to,direction,status,dateSent,dateCreated",
    ], "message"),
    run([
      "api:core:calls:list",
      "--start-time-after", after,
      ...(before ? ["--start-time-before", before] : []),
      "--no-limit",
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
  const entry: ProfileCache = cache.get(id) ?? { coveredFrom: null, fetchedThrough: null, events: new Map() };
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
    for (const event of events) entry.events.set(event.sid, event);
  };

  if (!entry.coveredFrom || !entry.fetchedThrough) {
    merge(await listTraffic(profile, from, undefined, 300_000, signal));
    entry.coveredFrom = from;
  } else {
    // Re-read the previous day too, so late-arriving records near midnight are picked up.
    const recentFrom = shiftDay(entry.fetchedThrough, -1);
    const [older, recent] = await Promise.all([
      from < entry.coveredFrom ? listTraffic(profile, from, entry.coveredFrom, 300_000, signal) : Promise.resolve([]),
      listTraffic(profile, recentFrom, undefined, 60_000, signal),
    ]);
    merge(older);
    merge(recent);
    if (from < entry.coveredFrom) entry.coveredFrom = from;
  }
  await names;
  entry.fetchedThrough = today;
  cache.set(id, entry);
  return { profile, events: [...entry.events.values()], names: entry.names, owned: entry.owned };
}

export type LoadedSources = { sources: ProfileEvents[]; errors: ProfileError[] };

/** Loads every profile's inbound events (cached where possible). Filtering and bucketing happen in the UI. */
export async function fetchSources(period: Period, profiles: string[], { signal }: { signal?: AbortSignal } = {}): Promise<LoadedSources> {
  const today = dayKey(new Date(), "utc");
  // Two periods for the comparison, plus a day of slack for local time zones.
  const from = shiftDay(today, -(period * 2));
  const ids = profiles.length ? profiles : [undefined];

  const settled = await Promise.allSettled(ids.map((profile) => loadProfile(profile, from, today, signal)));
  signal?.throwIfAborted();

  const sources: ProfileEvents[] = [];
  const errors: ProfileError[] = [];
  settled.forEach((result, index) => {
    const profile = ids[index];
    if (result.status === "fulfilled") sources.push(result.value);
    else errors.push({ profile, message: result.reason instanceof Error ? result.reason.message : String(result.reason) });
  });
  if (!sources.length && errors.length) {
    throw new Error(errors.map((error) => `${error.profile ?? "active"}: ${error.message}`).join(" · "));
  }
  return { sources, errors };
}

/** Returns cached events when every profile is already loaded far enough back, so range changes redraw instantly. */
export function cachedSources(period: Period, profiles: string[]): ProfileEvents[] | null {
  const from = shiftDay(dayKey(new Date(), "utc"), -(period * 2));
  const ids = profiles.length ? profiles : [undefined];
  const sources: ProfileEvents[] = [];
  for (const profile of ids) {
    const entry = cache.get(profile ?? "");
    if (!entry?.coveredFrom || entry.coveredFrom > from) return null;
    sources.push({ profile, events: [...entry.events.values()], names: entry.names, owned: entry.owned });
  }
  return sources;
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
  cache.clear();
}
