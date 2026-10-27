import { combineCoverage, coverageAt, dayBounds, summarizeCoverage, type CoverageSnapshot, type CoverageState, type CoverageSummary } from "./coverage";

export type Period = number;
export type CalendarPreset = "mtd" | "qtd";
export type TimeZoneMode = "utc" | "local";
export type DirectionMode = "both" | "in" | "out";
export type ChartInterval = "daily" | "weekly";

export type TrafficEvent = {
  sid: string;
  time: number;
  kind: "message" | "call";
  direction: "in" | "out";
  from: string;
  to: string;
  /** Parent call SID for forwarded call legs (`outbound-dial`). */
  parent?: string;
};

export type ProfileEvents = {
  profile?: string;
  events: TrafficEvent[];
  /** Friendly names of the account's phone numbers, keyed by number. */
  names?: Record<string, string>;
  /** Every phone number on the account, so lines without traffic still appear. */
  owned?: string[];
  coverage?: CoverageSnapshot;
};

export type ProfileError = {
  profile?: string;
  message: string;
};

export type Counts = {
  msgIn: number;
  msgOut: number;
  callIn: number;
  callOut: number;
};

export type TrafficRow = Counts & { date: string; endDate?: string; coverage?: CoverageState; contacts?: number; inProgress?: boolean };
export type ContactCounts = Counts & { contacts: number };
export type UniqueTraffic = { rows: TrafficRow[]; totals: ContactCounts };
export type ActivityEvent = TrafficEvent & { profile?: string; lineKey: string };

export function validDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

/** Inclusive calendar dates; use calendar keys so DST never changes the day count. */
export function dateWindow(start: string, end: string): { period: Period; end: string } {
  if (!validDay(start) || !validDay(end)) throw new Error("Use valid dates in YYYY-MM-DD format");
  const period = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
  if (period < 1 || period > 3660) throw new Error("Choose a start before the end, within a 10-year window");
  return { period, end };
}

/** Calendar periods through today, using the selected zone's calendar date. */
export function calendarWindow(preset: CalendarPreset, timeZone: TimeZoneMode, now = new Date()) {
  const end = dayKey(now, timeZone);
  const month = Number(end.slice(5, 7));
  const firstMonth = preset === "mtd" ? month : Math.floor((month - 1) / 3) * 3 + 1;
  const start = `${end.slice(0, 4)}-${String(firstMonth).padStart(2, "0")}-01`;
  return { start, ...dateWindow(start, end) };
}

/** Observed current-day counts can be plotted while genuine coverage gaps stay unknown. */
export function plottable(row: Pick<TrafficRow, "coverage" | "inProgress">): boolean {
  return !row.coverage || row.coverage === "complete" || !!row.inProgress;
}

/** Monday–Sunday weeks, clipped to the selected dates in the rows' time zone. */
export function groupTrafficRows(rows: TrafficRow[], interval: ChartInterval): TrafficRow[] {
  if (interval === "daily") return rows;
  const weeks = new Map<string, TrafficRow>();
  for (const row of rows) {
    const monday = shiftDay(row.date, -((new Date(`${row.date}T00:00:00Z`).getUTCDay() + 6) % 7));
    const week = weeks.get(monday);
    if (!week) {
      weeks.set(monday, { ...row, endDate: row.date });
      continue;
    }
    const inProgress = (week.inProgress || row.inProgress) && plottable(week) && plottable(row);
    for (const field of Object.keys(emptyCounts()) as Array<keyof Counts>) week[field] += row[field];
    week.endDate = row.date;
    if (inProgress) week.inProgress = true; else delete week.inProgress;
    if (week.coverage || row.coverage) {
      const earlier = week.coverage ?? "complete";
      const current = row.coverage ?? "complete";
      week.coverage = earlier === current ? earlier : "partial";
    }
  }
  return [...weeks.values()];
}

export function cumulativeRows(rows: TrafficRow[]): TrafficRow[] {
  const sum = emptyCounts();
  let complete = true;
  let observed = true;
  return rows.map((row) => {
    for (const field of Object.keys(sum) as Array<keyof Counts>) sum[field] += row[field];
    observed &&= plottable(row);
    complete &&= !row.coverage || row.coverage === "complete";
    return { ...row, ...sum, ...(row.inProgress ? { inProgress: observed } : {}), ...(row.coverage ? { coverage: complete ? "complete" as const : "partial" as const } : {}) };
  });
}

/** One of the account's own numbers (or a sender that carried traffic). */
export type LineTraffic = Counts & {
  key: string;
  number: string;
  name?: string;
  profile?: string;
  owned: boolean;
  previous: Counts;
  daily: Record<string, TrafficRow>;
  contacts?: number;
};

/** An outside number that exchanged traffic with the selected lines. */
export type PeerTraffic = Counts & { number: string };

export type DashboardData = {
  period: Period;
  timeZone: TimeZoneMode;
  rows: TrafficRow[];
  activity: ActivityEvent[];
  totals: Counts;
  previous: Counts;
  coverage: { current: CoverageSummary; previous: CoverageSummary };
  lines: LineTraffic[];
  peers: PeerTraffic[];
  /** Events in the current period dropped because the outside number is excluded. */
  excludedEvents: number;
  /** Lines removed by the name filter. */
  filteredOut: number;
  filter: string;
  errors: ProfileError[];
};

export const emptyCounts = (): Counts => ({ msgIn: 0, msgOut: 0, callIn: 0, callOut: 0 });

export function countField(event: Pick<TrafficEvent, "kind" | "direction">): keyof Counts {
  if (event.kind === "message") return event.direction === "in" ? "msgIn" : "msgOut";
  return event.direction === "in" ? "callIn" : "callOut";
}

/** Collapses directional counts to messages and calls for the chosen direction. */
export function pick(counts: Counts, mode: DirectionMode): { messages: number; calls: number } {
  return {
    messages: (mode !== "out" ? counts.msgIn : 0) + (mode !== "in" ? counts.msgOut : 0),
    calls: (mode !== "out" ? counts.callIn : 0) + (mode !== "in" ? counts.callOut : 0),
  };
}

export function totalOf(counts: Counts & { contacts?: number }, mode: DirectionMode = "both"): number {
  if (counts.contacts !== undefined) return counts.contacts;
  const { messages, calls } = pick(counts, mode);
  return messages + calls;
}

export function dayKey(time: number | Date, timeZone: TimeZoneMode): string {
  const date = typeof time === "number" ? new Date(time) : time;
  if (timeZone === "utc") return date.toISOString().slice(0, 10);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Moves a YYYY-MM-DD calendar key by whole days, independent of time zone. */
export function shiftDay(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

export function lineKey(profile: string | undefined, number: string): string {
  return `${profile ?? ""}\u0000${number}`;
}

/** Drops channel prefixes such as `whatsapp:` so a number's SMS and WhatsApp traffic share one line. */
export function canonicalNumber(value: string): string {
  const trimmed = value.trim().replace(/^(whatsapp|messenger|rcs|sms|mms):/i, "");
  return trimmed || "Unknown";
}

/**
 * Comparison key for exclusions: digits only, with US 10-digit numbers given a
 * leading 1, so "+1 (555) 010-0001", "5550100001" and "whatsapp:+15550100001" all match.
 * Non-phone identifiers (client:alice, sip:…) compare case-insensitively as-is.
 */
export function numberMatchKey(value: string): string {
  const canonical = canonicalNumber(value);
  if (!/^\+?[\d\s().-]+$/.test(canonical)) return canonical.toLowerCase();
  const digits = canonical.replace(/\D/g, "");
  return digits.length === 10 ? `1${digits}` : digits;
}

/** Unique phone numbers, deduplicated separately for each bucket or the running window.
 * Counts use the incoming fields after applying the requested direction, so the same
 * contact across channels or directions is counted once in `contacts`.
 */
export function uniqueTraffic(events: ActivityEvent[], days: TrafficRow[], timeZone: TimeZoneMode, direction: DirectionMode,
  interval: ChartInterval = "daily", cumulative = false, maxBuckets?: number): UniqueTraffic {
  const byDay = new Map<string, Array<{ kind: TrafficEvent["kind"]; contact: string }>>();
  const validDates = new Set(days.map((row) => row.date));
  for (const event of events) {
    if (direction !== "both" && event.direction !== direction) continue;
    const date = dayKey(event.time, timeZone);
    if (!validDates.has(date)) continue;
    const number = canonicalNumber(event.direction === "in" ? event.from : event.to);
    // Withheld/unknown identifiers cannot establish a distinct phone number.
    if (!/^\+?[\d\s().-]+$/.test(number) || !/\d/.test(number)) continue;
    const entry = { kind: event.kind, contact: numberMatchKey(number) };
    const entries = byDay.get(date) ?? [];
    entries.push(entry);
    byDay.set(date, entries);
  }
  const allTexts = new Set<string>();
  const allCalls = new Set<string>();
  const allContacts = new Set<string>();
  const counts = (texts: Set<string>, calls: Set<string>, contacts: Set<string>): ContactCounts => ({
    ...emptyCounts(), msgIn: texts.size, callIn: calls.size, contacts: contacts.size,
  });
  let grouped = groupTrafficRows(days, interval);
  // A narrow chart may need several periods per column. Deduplicate the full
  // bucket's dates rather than adding unique counts (or taking its last day).
  if (maxBuckets && grouped.length > maxBuckets) {
    const original = grouped;
    grouped = Array.from({ length: maxBuckets }, (_, index) => {
      const from = Math.floor(index * original.length / maxBuckets);
      const through = Math.floor((index + 1) * original.length / maxBuckets);
      const included = original.slice(from, through);
      const first = included[0]!;
      const last = included.at(-1)!;
      const states = included.map((row) => row.coverage ?? "complete");
      const coverage = states.every((state) => state === "complete") ? "complete" : states.every((state) => state === "missing") ? "missing" : "partial";
      return { ...first, endDate: last.endDate ?? last.date, coverage,
        ...(included.some((row) => row.inProgress) ? { inProgress: included.every(plottable) } : {}) };
    });
  }
  const templates = cumulative ? cumulativeRows(grouped) : grouped;
  const rows = templates.map((row) => {
    const texts = cumulative ? allTexts : new Set<string>();
    const calls = cumulative ? allCalls : new Set<string>();
    const contacts = cumulative ? allContacts : new Set<string>();
    for (let date = row.date; date <= (row.endDate ?? row.date); date = shiftDay(date, 1)) {
      for (const event of byDay.get(date) ?? []) {
        (event.kind === "message" ? texts : calls).add(event.contact);
        (event.kind === "message" ? allTexts : allCalls).add(event.contact);
        contacts.add(event.contact);
        allContacts.add(event.contact);
      }
    }
    return { ...row, ...counts(texts, calls, contacts) };
  });
  return { rows, totals: counts(allTexts, allCalls, allContacts) };
}

/** Lowercase, drop punctuation, and collapse doubled letters so "Guerilla" also matches "Guerrilla". */
function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/([a-z])\1+/g, "$1");
}

/**
 * Comma-separated terms matched against a line's name and number. A line must
 * contain at least one plain term (when any are given) and none of the `-` terms.
 */
export function matchesFilter(filter: string, name: string | undefined, number: string): boolean {
  const raw = filter.split(",").map((term) => term.trim()).filter(Boolean);
  const include = raw.filter((term) => !term.startsWith("-")).map(normalizeForMatch).filter(Boolean);
  const exclude = raw.filter((term) => term.startsWith("-")).map((term) => normalizeForMatch(term.slice(1))).filter(Boolean);
  const haystack = `${normalizeForMatch(name ?? "")} ${normalizeForMatch(number)}`;
  if (exclude.some((term) => haystack.includes(term))) return false;
  return !include.length || include.some((term) => haystack.includes(term));
}

/** Marks days with at least 3× the series' daily average (and at least 5 events). */
export function spikeFlags(values: number[]): boolean[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  const threshold = Math.max(5, values.length ? total / values.length * 3 : 0);
  return values.map((value) => value >= threshold);
}

export function buildDashboard(
  sources: ProfileEvents[],
  period: Period,
  timeZone: TimeZoneMode,
  { now = new Date(), endDay, errors = [], filter = "", excluded = [] }: {
    now?: Date;
    endDay?: string;
    errors?: ProfileError[];
    filter?: string;
    excluded?: string[];
  } = {},
): DashboardData {
  if (!Number.isInteger(period) || period < 1 || period > 3660) throw new Error("Choose a window between 1 and 3660 days");
  const end = endDay ?? dayKey(now, timeZone);
  dateWindow(shiftDay(end, -(period - 1)), end);
  const start = shiftDay(end, -(period - 1));
  const previousStart = shiftDay(start, -period);
  const rowMap = new Map<string, TrafficRow>();
  const lineMap = new Map<string, LineTraffic>();
  const peerMap = new Map<string, PeerTraffic>();
  const filteredKeys = new Set<string>();
  const excludedKeys = new Set(excluded.map(numberMatchKey));
  const totals = emptyCounts();
  const previous = emptyCounts();
  const activity: ActivityEvent[] = [];
  let excludedEvents = 0;

  const dayCoverage = (date: string): CoverageState => {
    const { from, through } = dayBounds(date, timeZone);
    return combineCoverage(sources.map((source) => source.coverage ? coverageAt(source.coverage, from, through) : "complete"));
  };
  const previousCoverage: CoverageState[] = [];

  for (let offset = 0; offset < period; offset++) {
    const key = shiftDay(start, offset);
    const coverage = dayCoverage(key);
    const { from, through } = dayBounds(key, timeZone);
    const inProgress = key === dayKey(now, timeZone) && coverage === "partial" && sources.every((source) => {
      if (!source.coverage || coverageAt(source.coverage, from, through) === "complete") return true;
      const liveEnd = source.coverage.live?.through;
      return !!liveEnd && liveEnd > from && coverageAt(source.coverage, from, Math.min(liveEnd, through)) === "complete";
    });
    rowMap.set(key, { date: key, ...emptyCounts(), coverage, ...(inProgress ? { inProgress: true } : {}) });
    previousCoverage.push(dayCoverage(shiftDay(previousStart, offset)));
  }

  for (const source of sources) {
    const names = source.names ?? {};
    const owned = new Set((source.owned ?? []).map(canonicalNumber));
    const getLine = (number: string): LineTraffic | null => {
      const key = lineKey(source.profile, number);
      const existing = lineMap.get(key);
      if (existing) return existing;
      const name = names[number];
      if (!matchesFilter(filter, name, number)) {
        filteredKeys.add(key);
        return null;
      }
      const line: LineTraffic = {
        key,
        number,
        ...(name ? { name } : {}),
        profile: source.profile,
        owned: owned.has(number),
        ...emptyCounts(),
        previous: emptyCounts(),
        daily: {},
      };
      lineMap.set(key, line);
      return line;
    };

    // Every number on the account is listed, even without traffic.
    for (const number of owned) getLine(number);

    // Forwarded call legs belong to the line that received the original call, and are
    // excluded along with it when the original caller is excluded.
    const callLines = new Map<string, { line: string; caller: string }>();
    for (const event of source.events) {
      if (event.kind === "call" && event.direction === "in" && !event.parent) callLines.set(event.sid, { line: canonicalNumber(event.to), caller: canonicalNumber(event.from) });
    }

    for (const event of source.events) {
      const key = dayKey(event.time, timeZone);
      if (key < previousStart || key > end) continue;

      let number = canonicalNumber(event.direction === "in" ? event.to : event.from);
      let peer = canonicalNumber(event.direction === "in" ? event.from : event.to);
      const parentCall = event.parent ? callLines.get(event.parent) : undefined;
      // Child legs that Twilio also marks inbound (e.g. a browser client answering) are part of the
      // parent call, which is already counted, so they are skipped rather than double counted.
      if (parentCall && event.direction === "in") continue;
      if (parentCall) {
        number = parentCall.line;
      } else if (owned.size && !owned.has(number) && owned.has(peer)) {
        [number, peer] = [peer, number];
      }

      const line = getLine(number);
      if (!line) continue;
      const field = countField(event);
      const current = key >= start;

      if (current) {
        const peerKey = numberMatchKey(peer);
        const peerEntry = peerMap.get(peerKey) ?? { number: peer, ...emptyCounts() };
        peerEntry[field]++;
        peerMap.set(peerKey, peerEntry);
      }
      if (excludedKeys.has(numberMatchKey(peer)) || (parentCall && excludedKeys.has(numberMatchKey(parentCall.caller)))) {
        if (current) excludedEvents++;
        continue;
      }

      if (!current) {
        previous[field]++;
        line.previous[field]++;
        continue;
      }
      totals[field]++;
      activity.push({ ...event, profile: source.profile, lineKey: line.key });
      rowMap.get(key)![field]++;
      line[field]++;
      const daily = line.daily[key] ?? { date: key, ...emptyCounts() };
      daily[field]++;
      line.daily[key] = daily;
    }
  }

  // Unowned numbers only stay listed while they carry traffic; owned lines always stay.
  const lines = [...lineMap.values()].filter((line) => line.owned || totalOf(line) + totalOf(line.previous) > 0);
  const peers = [...peerMap.values()].sort((a, b) => totalOf(b) - totalOf(a) || a.number.localeCompare(b.number));

  return {
    period,
    timeZone,
    rows: [...rowMap.values()],
    activity: activity.sort((a, b) => b.time - a.time || a.sid.localeCompare(b.sid)),
    totals,
    previous,
    coverage: { current: summarizeCoverage([...rowMap.values()].map((row) => row.coverage!)), previous: summarizeCoverage(previousCoverage) },
    lines,
    peers,
    excludedEvents,
    filteredOut: filteredKeys.size,
    filter,
    errors,
  };
}

export function dashboardCsv(data: DashboardData, { direction = "both", lineKey: selectedKey, unique = false }: { direction?: DirectionMode; lineKey?: string; unique?: boolean } = {}): string {
  if (unique) return uniqueDashboardCsv(data, direction, selectedKey);
  const lines = [`scope,date_${data.timeZone},account,line,name,messages_in,messages_out,calls_in,calls_out,total,coverage`];
  const addRow = (values: Array<string | number>) => {
    lines.push(values.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","));
  };
  const counts = (value: Counts, coverage: CoverageState = "complete") => coverage === "missing" ? ["", "", "", "", ""] : [
    direction !== "out" ? value.msgIn : 0,
    direction !== "in" ? value.msgOut : 0,
    direction !== "out" ? value.callIn : 0,
    direction !== "in" ? value.callOut : 0,
    totalOf(value, direction),
  ];
  const selectedLine = selectedKey === undefined ? undefined : data.lines.find((line) => line.key === selectedKey);
  const viewLines = selectedKey === undefined ? data.lines : selectedLine ? [selectedLine] : [];
  const account = selectedKey === undefined ? "selection" : selectedLine?.profile ?? "active";

  const firstDate = data.rows[0]?.date ?? "";
  const lastDate = data.rows.at(-1)?.date ?? "";
  const allLabel = selectedKey !== undefined ? selectedLine?.number ?? "selected number" : data.filter ? `lines matching "${data.filter}"` : "all lines";
  const name = selectedLine?.name ?? "";
  const totals = selectedKey === undefined ? data.totals : selectedLine ?? emptyCounts();
  addRow(["total", firstDate && lastDate ? `${firstDate}..${lastDate}` : "", account, allLabel, name, ...counts(totals), data.coverage.current.complete === data.period ? "complete" : "partial"]);
  for (const row of data.rows) {
    const daily = selectedKey === undefined ? row : selectedLine?.daily[row.date] ?? emptyCounts();
    addRow(["daily", row.date, account, allLabel, name, ...counts(daily, row.coverage), row.coverage ?? "complete"]);
    for (const line of viewLines) {
      const daily = line.daily[row.date] ?? emptyCounts();
      addRow(["line_daily", row.date, line.profile ?? "active", line.number, line.name ?? "", ...counts(daily, row.coverage), row.coverage ?? "complete"]);
    }
  }

  return `${lines.join("\n")}\n`;
}

function uniqueDashboardCsv(data: DashboardData, direction: DirectionMode, selectedKey?: string): string {
  const output = [`scope,date_${data.timeZone},account,line,name,unique_texters,unique_callers,unique_contacts,coverage,direction`];
  const add = (scope: string, date: string, account: string, line: string, name: string, counts: Counts & { contacts?: number }, coverage: CoverageState) => {
    const values = coverage === "missing" ? ["", "", ""] : [counts.msgIn, counts.callIn, counts.contacts ?? 0];
    output.push([scope, date, account, line, name, ...values, coverage, direction].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","));
  };
  const selectedLine = data.lines.find((line) => line.key === selectedKey);
  const events = data.activity.filter((event) => selectedKey === undefined || event.lineKey === selectedKey);
  const view = uniqueTraffic(events, data.rows, data.timeZone, direction);
  const label = selectedKey === undefined ? "selected lines" : selectedLine?.number ?? "selected number";
  const account = selectedKey === undefined ? "selection" : selectedLine?.profile ?? "active";
  add("total", `${data.rows[0]?.date ?? ""}..${data.rows.at(-1)?.date ?? ""}`, account, label, selectedLine?.name ?? "", view.totals, data.coverage.current.complete === data.period ? "complete" : "partial");
  for (const row of view.rows) add("daily", row.date, account, label, selectedLine?.name ?? "", row, row.coverage ?? "complete");
  const byLine = new Map<string, ActivityEvent[]>();
  for (const event of events) {
    const entries = byLine.get(event.lineKey) ?? [];
    entries.push(event);
    byLine.set(event.lineKey, entries);
  }
  for (const line of data.lines.filter((line) => selectedKey === undefined || line.key === selectedKey)) {
    for (const row of uniqueTraffic(byLine.get(line.key) ?? [], data.rows, data.timeZone, direction).rows) {
      add("line_daily", row.date, line.profile ?? "active", line.number, line.name ?? "", row, row.coverage ?? "complete");
    }
  }
  return `${output.join("\n")}\n`;
}
