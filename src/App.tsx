import type { ImportProgress } from "./backfill";
import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import {
  accountLabelFor,
  accountChoices,
  savedAccounts,
  forgetAccount,
  downloadWindowPlan,
  validDay,
  buildDashboard,
  calendarWindow,
  cachedSources,
  createHistoryImporter,
  clearCache,
  dashboardCsv,
  emptyCounts,
  fetchSources,
  listCliProfiles,
  loadSettings,
  loadSavedCache,
  savedUpdatedAt,
  dayKey,
  shiftDay,
  numberMatchKey,
  pick,
  saveSettings,
  selectedProfiles,
  totalOf,
  uniqueTraffic,
  type ActivityEvent,
  type CliProfile,
  type CalendarPreset,
  type ChartInterval,
  type DirectionMode,
  type LineTraffic,
  type LoadedSources,
  type Period,
  type Settings,
  type TimeZoneMode,
  type HistorySettings,
} from "./data";
import { utcWindow } from "./coverage";
import {
  chartTypes,
  clipText,
  directionNames,
  exclusionRows,
  ExclusionsScreen,
  formatNumber,
  HelpOverlay,
  LineTable,
  MetricCard,
  MetricStrip,
  percentChange,
  ProfilePicker,
  Tab,
  TrafficChart,
  type ChartType,
} from "./components";
import { theme } from "./theme";
import { ActionsScreen, ActivityTable, DownloadsScreen, WindowScreen, type MenuAction } from "./screens";
import { SavedViewsScreen } from "./saved-views";
import { saveNamedView, type SavedView } from "./views";
import { EventDetailScreen } from "./event-detail-screen";

const periods: Period[] = [1, 7, 30, 90, 180, 365, 730];
const directions: DirectionMode[] = ["both", "in", "out"];

type PickerState = {
  open: boolean;
  available: CliProfile[];
  draft: string[];
  cursor: number;
  loadKey: number;
  loading: boolean;
  error: string | null;
};

type ExclusionState = { open: boolean; cursor: number; adding: boolean; input: string };
/** `fresh` means the draft is the previous filter and the first typed character replaces it. */
type FilterEdit = { editing: boolean; draft: string; fresh: boolean };
type Detail = Pick<LineTraffic, "key" | "number" | "name" | "profile">;

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function exportFileName(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return `twilio-tui-${stamp}.csv`;
}

/** Printable single characters typed into text inputs. */
function typedCharacter(key: { sequence: string; ctrl: boolean; meta: boolean }): string | null {
  if (key.ctrl || key.meta) return null;
  return key.sequence.length === 1 && key.sequence >= " " && key.sequence !== "\u007f" ? key.sequence : null;
}

export function App() {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const innerWidth = Math.max(40, width - 2);
  const wide = innerWidth >= 150 && height >= 24;
  const chartWidth = wide ? Math.floor(innerWidth * 0.5) : innerWidth;
  const [windowEnd, setWindowEnd] = useState<string | null>(null);
  const [fixedPeriod, setFixedPeriod] = useState<Period>(30);
  const [calendarPreset, setCalendarPreset] = useState<CalendarPreset | null>(null);
  const [timeZone, setTimeZone] = useState<TimeZoneMode>("utc");
  const calendarRange = calendarPreset ? calendarWindow(calendarPreset, timeZone) : null;
  const period = calendarRange?.period ?? fixedPeriod;
  const endDay = calendarRange?.end ?? windowEnd ?? dayKey(new Date(), timeZone);
  const setPeriod = (days: Period) => { setFixedPeriod(days); setCalendarPreset(null); };
  const chooseCalendarPreset = (preset: CalendarPreset) => { setCalendarPreset(preset); setWindowEnd(null); };
  const historyDays = Math.max(0, Math.round((Date.parse(dayKey(new Date(), timeZone)) - Date.parse(endDay)) / 86_400_000));
  const [windowOpen, setWindowOpen] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [downloadDraft, setDownloadDraft] = useState<HistorySettings | null>(null);
  const [downloadCursor, setDownloadCursor] = useState(0);
  const [downloadEdit, setDownloadEdit] = useState<string | null>(null);
  const [forgetId, setForgetId] = useState<string | null>(null);
  const [cumulative, setCumulative] = useState(true);
  const [chartInterval, setChartInterval] = useState<ChartInterval>("daily");
  const [chartVisible, setChartVisible] = useState(true);
  const [unique, setUnique] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [openedEvent, setOpenedEvent] = useState<ActivityEvent | null>(null);
  const [activityCursor, setActivityCursor] = useState(0);
  const [activityRange, setActivityRange] = useState<{ from: string; through: string } | null>(null);
  const [activityKind, setActivityKind] = useState<"all" | "message" | "call">("all");
  const [direction, setDirection] = useState<DirectionMode>("in");
  const [chartType, setChartType] = useState<ChartType>("line");
  const [refreshKey, setRefreshKey] = useState(0);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const historyView = useRef({ period, endDay });
  historyView.current = { period, endDay };
  const [helpOpen, setHelpOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [viewsOpen, setViewsOpen] = useState(false);

  // Persisted: which accounts are loaded, which one is in focus (null = all), the line filter and exclusions.
  const [settings, setSettings] = useState<Settings>({ profiles: selectedProfiles, focus: null, filter: "", excluded: [], importPaused: true });
  const [settingsReady, setSettingsReady] = useState(false);
  const [picker, setPicker] = useState<PickerState>({
    open: false, available: [], draft: [], cursor: 0, loadKey: 0, loading: false, error: null,
  });
  const [exclusions, setExclusions] = useState<ExclusionState>({ open: false, cursor: 0, adding: false, input: "" });
  const [filterEdit, setFilterEdit] = useState<FilterEdit>({ editing: false, draft: "", fresh: false });

  const [loaded, setLoaded] = useState<LoadedSources | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  // Selection follows a line (key), not a row position, so refreshes and re-sorts keep it stable.
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const lastCursorIndex = useRef(0);
  const [detail, setDetail] = useState<Detail | null>(null);

  const accounts = settings.profiles;
  const focus = settings.focus && accounts.includes(settings.focus) ? settings.focus : null;
  const accountsKey = accounts.join(",");
  const pickerProfiles = accountChoices(picker.available, [...accounts, ...picker.draft], savedAccounts());
  const downloadAccounts = accounts.length ? accounts : [""];
  const downloadOptions = downloadDraft ?? settings.history ?? {};
  const downloadSelected = (downloadOptions.profiles ?? downloadAccounts).filter((id) => downloadAccounts.includes(id));
  const runningProfiles = (settings.history?.profiles ?? downloadAccounts).filter((id) => downloadAccounts.includes(id));
  const downloadKey = JSON.stringify(runningProfiles);
  const historyOptionsKey = JSON.stringify(settings.history ?? {});
  const toggleDownload = (id: string) => {
    const profiles = downloadSelected.includes(id) ? downloadSelected.filter((entry) => entry !== id) : [...downloadSelected, id];
    if (downloadDraft) setDownloadDraft({ ...downloadDraft, profiles });
    else updateSettings({ history: { ...settings.history, profiles }, importPaused: profiles.length ? settings.importPaused : true });
  };
  const changePace = () => {
    const choices = [1, 5, 10, 30];
    const index = choices.indexOf(downloadOptions.intervalMinutes ?? 10);
    const history = { ...downloadOptions, intervalMinutes: choices[(index + 1) % choices.length] };
    if (downloadDraft) setDownloadDraft(history); else updateSettings({ history });
  };
  const moveWindow = (days: number) => {
    const target = shiftDay(endDay, days);
    setPeriod(period);
    setWindowEnd(target >= dayKey(new Date(), timeZone) ? null : target);
  };

  const updateSettings = (change: Partial<Settings>) => {
    setSettings((current) => {
      const next = { ...current, ...change };
      void saveSettings(next).catch((reason) => showNotice(`Could not save settings: ${errorMessage(reason)}`, true));
      return next;
    });
  };

  const showNotice = (text: string, isError = false) => setNotice({ text, error: isError });
  const previewWindowDownload = () => {
    const range = utcWindow(shiftDay(endDay, -(period - 1)), endDay, timeZone);
    const profiles = detail ? [detail.profile ?? ""] : focus ? [focus] : downloadAccounts;
    const plan = downloadWindowPlan(profiles, range, settings.history?.intervalMinutes ?? 10);
    setDownloadDraft({ ...settings.history, startDay: range.from, endDay: range.through,
      profiles: plan.accounts.filter((account) => account.days.length > 0 || account.unavailable > 0 || account.open > 0).map((account) => account.id) });
    setDownloadEdit(null);
    setDownloadCursor(0);
    setDownloadsOpen(true);
  };
  const runDownloads = () => {
    if (!downloadSelected.length) { showNotice("Select an account before starting downloads", true); return; }
    if ((downloadDraft || settings.importPaused) && downloadOptions.startDay && downloadOptions.endDay
      && !downloadWindowPlan(downloadSelected, { from: downloadOptions.startDay, through: downloadOptions.endDay }).days) {
      showNotice("No missing closed days available from the API; the open day uses recent sync"); return;
    }
    if (downloadDraft) { updateSettings({ history: downloadDraft, importPaused: false }); setDownloadDraft(null); }
    else updateSettings({ importPaused: !settings.importPaused });
  };

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.error ? 10_000 : 5_000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    let cancelled = false;
    void loadSavedCache().catch((reason) => showNotice(`Could not read saved traffic: ${errorMessage(reason)}`, true)).then(() => loadSettings()).then((saved) => {
      if (cancelled) return;
      // Profiles given on the command line win over the saved selection for this run.
      setSettings(selectedProfiles.length ? { ...saved, profiles: selectedProfiles, focus: null } : saved);
      setSettingsReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!picker.open) return;
    let cancelled = false;
    setPicker((current) => ({ ...current, loading: true, error: null }));
    void listCliProfiles().then((available) => {
      if (!cancelled) setPicker((current) => ({ ...current, available, loading: false }));
    }).catch((reason) => {
      if (!cancelled) setPicker((current) => ({ ...current, error: errorMessage(reason), loading: false }));
    });
    return () => { cancelled = true; };
  }, [picker.open, picker.loadKey]);

  useEffect(() => {
    if (!settingsReady) return;
    const requestProfiles = accountsKey ? accountsKey.split(",") : [];
    let controller: AbortController | null = null;
    let disposed = false;

    // Redraw straight away from cached events when they already cover the range.
    const endDate = new Date(`${endDay}T12:00:00Z`);
    const cached = cachedSources(period, requestProfiles, endDate, true);
    setLoaded(cached ? { sources: cached, errors: [] } : null);
    setLastUpdated(savedUpdatedAt(requestProfiles));
    setError(null);
    if (historyDays > 0) { setLoading(false); return; }
    if (cached) setLoaded((current) => ({ sources: cached, errors: current?.errors ?? [] }));

    const load = async () => {
      if (controller) return;
      controller = new AbortController();
      setLoading(true);
      try {
        const next = await fetchSources(period, requestProfiles, { signal: controller.signal });
        if (disposed) return;
        setLoaded(next);
        if (next.storageError) showNotice(next.storageError, true);
        setError(null);
        setLastUpdated(savedUpdatedAt(requestProfiles));
      } catch (reason) {
        if (!disposed) setError(errorMessage(reason));
      } finally {
        controller = null;
        if (!disposed) setLoading(false);
      }
    };

    const savedAt = savedUpdatedAt(requestProfiles);
    if (!cached || !cachedSources(30, requestProfiles) || refreshKey > 0 || !savedAt || Date.now() - savedAt.getTime() >= 600_000) void load();
    else setLoading(false);
    const timer = setInterval(() => void load(), 600_000);
    return () => {
      disposed = true;
      clearInterval(timer);
      controller?.abort();
    };
  }, [period, refreshKey, accountsKey, settingsReady, endDay]);

  useEffect(() => {
    if (!settingsReady || settings.importPaused || !runningProfiles.length) return;
    const requestProfiles = JSON.parse(downloadKey) as string[];
    const importer = createHistoryImporter(requestProfiles, settings.history);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setImportProgress({ phase: "starting", completed: 0, total: 0, message: "Preparing API history import" });
    let stageStartedAt = Date.now();
    const heartbeat = setInterval(() => {
      if (controller.signal.aborted) return;
      setImportProgress((current) => current && ["starting", "importing"].includes(current.phase)
        ? { ...current, elapsedSeconds: Math.floor((Date.now() - stageStartedAt) / 1000) } : current);
    }, 1000);
    const tick = async () => {
      try {
        const progress = await importer.step(controller.signal, (next) => {
          if (controller.signal.aborted) return;
          stageStartedAt = Date.now();
          setImportProgress({ ...next, elapsedSeconds: 0 });
        });
        if (controller.signal.aborted) return;
        stageStartedAt = Date.now();
        setImportProgress(progress);
        const end = new Date(`${historyView.current.endDay}T12:00:00Z`);
        const viewProfiles = accountsKey ? accountsKey.split(",") : [];
        const sources = progress.changed ? cachedSources(historyView.current.period, viewProfiles, end, true) : null;
        if (sources) setLoaded((current) => ({ sources, errors: current?.errors ?? [] }));
        timer = setTimeout(() => void tick(), progress.phase === "complete" ? 600_000 : 30_000);
      } catch (reason) {
        if (!controller.signal.aborted) {
          setImportProgress({ phase: "retrying", completed: 0, total: 0, message: errorMessage(reason) });
          timer = setTimeout(() => void tick(), 60_000);
        }
      }
    };
    void tick();
    return () => { controller.abort(); clearInterval(heartbeat); if (timer) clearTimeout(timer); };
  }, [settingsReady, settings.importPaused, accountsKey, downloadKey, historyOptionsKey, refreshKey]);

  const data = useMemo(() => {
    if (!loaded) return null;
    const sources = focus ? loaded.sources.filter((source) => source.profile === focus) : loaded.sources;
    const errors = focus ? loaded.errors.filter((entry) => entry.profile === focus) : loaded.errors;
    return buildDashboard(sources, period, timeZone, { endDay, errors, filter: settings.filter, excluded: settings.excluded });
  }, [loaded, focus, period, timeZone, settings.filter, settings.excluded, endDay]);

  const lines = useMemo(() => {
    let all = data?.lines ?? [];
    if (unique && data) {
      const byLine = new Map<string, ActivityEvent[]>();
      for (const event of data.activity) {
        const entries = byLine.get(event.lineKey) ?? [];
        entries.push(event);
        byLine.set(event.lineKey, entries);
      }
      all = all.map((line) => {
        const view = uniqueTraffic(byLine.get(line.key) ?? [], data.rows, timeZone, direction);
        return { ...line, ...view.totals, daily: Object.fromEntries(view.rows.map((row) => [row.date, row])) };
      });
    }
    return [...all].sort((a, b) => totalOf(b, direction) - totalOf(a, direction)
      || (a.name ?? "￿").localeCompare(b.name ?? "￿")
      || a.key.localeCompare(b.key));
  }, [data, direction, unique, timeZone]);
  const uniqueView = useMemo(() => unique && data ? uniqueTraffic(
    data.activity.filter((event) => !detail || event.lineKey === detail.key), data.rows, timeZone, direction, chartInterval, cumulative,
    chartType === "table" ? undefined : Math.max(4, chartWidth - 11),
  ) : undefined, [unique, data, detail?.key, timeZone, direction, chartInterval, cumulative, chartType, chartWidth]);
  const foundIndex = cursorKey ? lines.findIndex((entry) => entry.key === cursorKey) : -1;
  const cursorIndex = foundIndex >= 0 ? foundIndex : Math.max(0, Math.min(lastCursorIndex.current, lines.length - 1));
  lastCursorIndex.current = cursorIndex;

  const activityEvents = useMemo(() => (data?.activity ?? []).filter((event) =>
    (!detail || event.lineKey === detail.key) && (direction === "both" || event.direction === direction)
    && (activityKind === "all" || event.kind === activityKind)
    && (!activityRange || (dayKey(event.time, timeZone) >= activityRange.from && dayKey(event.time, timeZone) <= activityRange.through))), [data, detail, direction, activityKind, activityRange, timeZone]);
  useEffect(() => setActivityCursor(0), [endDay, period, focus, direction, activityKind, detail?.key, settings.filter, settings.excluded, activityRange]);
  useEffect(() => setActivityRange(null), [endDay, period, focus, direction, timeZone, detail?.key, settings.filter, settings.excluded]);

  const peerRows = exclusionRows(data?.peers ?? [], settings.excluded);

  const setFocus = (next: string | null) => {
    setDetail(null);
    updateSettings({ focus: next });
  };

  const stepFocus = (step: -1 | 1) => {
    if (accounts.length < 2) return;
    const options: Array<string | null> = [null, ...accounts];
    const index = options.indexOf(focus);
    setFocus(options[(index + step + options.length) % options.length]!);
  };

  const openDetail = (entry: LineTraffic | undefined) => {
    if (!entry) return;
    setCursorKey(entry.key);
    setDetail({ key: entry.key, number: entry.number, name: entry.name, profile: entry.profile });
  };

  const closeDetail = () => {
    setDetail(null);
    setActivityOpen(false);
    setActivityKind("all");
    setActivityRange(null);
  };

  const moveCursor = (step: -1 | 1) => {
    if (!lines.length) return;
    const next = lines[Math.max(0, Math.min(lines.length - 1, cursorIndex + step))]!;
    setCursorKey(next.key);
    if (detail) setDetail({ key: next.key, number: next.number, name: next.name, profile: next.profile });
  };

  const toggleExcluded = (number: string) => {
    const key = numberMatchKey(number);
    const present = settings.excluded.some((entry) => numberMatchKey(entry) === key);
    updateSettings({
      excluded: present
        ? settings.excluded.filter((entry) => numberMatchKey(entry) !== key)
        : [...settings.excluded, number],
    });
  };
  const addExcluded = () => {
    const number = exclusions.input.trim();
    if (number && !settings.excluded.some((entry) => numberMatchKey(entry) === numberMatchKey(number))) updateSettings({ excluded: [...settings.excluded, number] });
    setExclusions((current) => ({ ...current, adding: false, input: "", cursor: 0 }));
  };
  const applyFilter = () => {
    setFilterEdit({ editing: false, draft: "", fresh: false });
    setDetail(null);
    updateSettings({ filter: filterEdit.draft.trim() });
  };
  const applyDownloadDate = () => {
    if (downloadEdit === null) return;
    if (!validDay(downloadEdit) || downloadEdit > dayKey(new Date(), "utc")) { showNotice("Use YYYY-MM-DD, today or earlier", true); return; }
    const history = { ...downloadOptions, startDay: downloadEdit, endDay: undefined };
    if (downloadDraft) setDownloadDraft(history); else updateSettings({ history });
    setDownloadEdit(null);
  };

  const exportCsv = () => {
    if (!data) {
      showNotice("Waiting for data before CSV export");
      return;
    }
    const file = exportFileName();
    void Bun.write(file, dashboardCsv(data, { direction, lineKey: detail?.key, unique }))
      .then(() => showNotice(`Exported ${file}`))
      .catch((reason) => showNotice(`CSV export failed: ${errorMessage(reason)}`, true));
  };

  const openAccounts = () => setPicker((current) => ({ ...current, open: true, draft: accounts, cursor: 0, loading: true, error: null }));
  const toggleProfile = (id: string) => setPicker((current) => ({ ...current,
    draft: current.draft.includes(id) ? current.draft.filter((entry) => entry !== id) : [...current.draft, id],
  }));
  const applyAccounts = () => {
    setDetail(null);
    updateSettings({ profiles: [...picker.draft], focus: picker.draft.includes(focus ?? "") ? focus : null });
    setPicker((current) => ({ ...current, open: false }));
  };
  const confirmForget = () => {
    if (forgetId === null) return;
    try {
      forgetAccount(forgetId);
      updateSettings({ profiles: accounts.filter((id) => id !== forgetId), focus: focus === forgetId ? null : focus,
        history: { ...settings.history, profiles: downloadSelected.filter((id) => id !== forgetId) } });
      setPicker((current) => ({ ...current, draft: current.draft.filter((id) => id !== forgetId), cursor: 0 }));
      setDetail(null);
      setRefreshKey((value) => value + 1);
      showNotice(`Removed saved account ${forgetId}`);
    } catch (reason) { showNotice(errorMessage(reason), true); }
    setForgetId(null);
  };
  const openFilter = () => setFilterEdit({ editing: true, draft: settings.filter, fresh: !!settings.filter });
  const nextDirection = () => setDirection((current) => directions[(directions.indexOf(current) + 1) % directions.length]!);
  const nextChart = () => setChartType((current) => chartTypes[(chartTypes.indexOf(current) + 1) % chartTypes.length]!);
  const toggleTimeZone = () => setTimeZone((current) => current === "utc" ? "local" : "utc");
  const toggleCumulative = () => {
    if (!chartVisible) { setChartVisible(true); setCumulative(true); }
    else setCumulative((value) => !value);
  };
  const toggleChartInterval = () => setChartInterval((value) => value === "daily" ? "weekly" : "daily");
  const saveView = (name: string): string | null => {
    try {
      const view: SavedView = { name, profiles: [...accounts], focus, filter: settings.filter, excluded: [...settings.excluded],
        period, endDay: windowEnd, calendarPreset, timeZone, direction, chartType, chartInterval, cumulative, chartVisible, unique,
        ...(detail ? { line: { ...detail } } : {}) };
      updateSettings({ views: saveNamedView(settings.views ?? [], view) });
      return null;
    } catch (reason) { return errorMessage(reason); }
  };
  const loadView = (view: SavedView) => {
    updateSettings({ profiles: [...view.profiles], focus: view.focus, filter: view.filter, excluded: [...view.excluded] });
    setPeriod(view.period);
    setWindowEnd(view.endDay && view.endDay < dayKey(new Date(), view.timeZone) ? view.endDay : null);
    setCalendarPreset(view.calendarPreset);
    setTimeZone(view.timeZone); setDirection(view.direction);
    setChartType(view.chartType); setChartInterval(view.chartInterval); setCumulative(view.cumulative);
    setChartVisible(view.chartVisible); setUnique(view.unique); setDetail(view.line ?? null);
    setCursorKey(view.line?.key ?? null); setActivityOpen(false); setActivityRange(null); setActivityKind("all");
    setViewsOpen(false);
    showNotice(`Loaded view “${view.name}”`);
  };
  const menuActions: MenuAction[] = [
    { label: "Choose dates and time period", shortcut: "W", description: "Choose a preset or enter exact start and end dates.", run: () => setWindowOpen(true) },
    { label: activityOpen ? "Show phone lines" : "Show messages and voice calls", shortcut: "V", description: "Switch between phone lines and individual events in this window.", run: () => setActivityOpen((value) => !value) },
    { label: "Saved views", shortcut: "S", description: "Name this dashboard or restore saved accounts, filters, dates, and charts.", run: () => setViewsOpen(true) },
    { label: chartVisible && cumulative ? `Show ${chartInterval} counts` : "Show the cumulative chart", shortcut: "C", description: "Cumulative texts, calls, and total events from the window start. Summary totals stay visible.", run: toggleCumulative },
    { label: chartVisible ? "Hide the chart" : "Show the chart", shortcut: "G", description: "Give the event or number list more space while keeping campaign totals visible.", run: () => setChartVisible((value) => !value) },
    { label: chartInterval === "daily" ? "Group the chart by week" : "Group the chart by day", shortcut: "I", description: "Weeks run Monday–Sunday in the selected time zone, limited to your selected dates. Works with cumulative counts too.", run: toggleChartInterval },
    { label: unique ? "Count all events" : "Count unique callers and texters", shortcut: "N", description: "Count distinct phone numbers. Combined contacts count callers who also text only once; cumulative counts deduplicate across weeks.", run: () => setUnique((value) => !value) },
    { label: "Manage history downloads", shortcut: "B", description: "Choose accounts, oldest date, pace, and start or pause downloads.", run: () => setDownloadsOpen(true) },
    { label: "Download missing data for this window", shortcut: "U", description: "Preview missing days and an estimate before starting a download.", run: previewWindowDownload },
    { label: "Manage connected and saved accounts", shortcut: "P", description: "Choose accounts to load or forget a disconnected saved account.", run: openAccounts },
    { label: "Previous time window", shortcut: "-", description: `Move ${period} days older, keeping the same window length.`, run: () => moveWindow(-period) },
    { label: "Next time window", shortcut: "=", description: `Move ${period} days newer, stopping at today.`, run: () => moveWindow(period) },
    { label: "Return to today", shortcut: "H", description: "End the current time window today.", run: () => setWindowEnd(null) },
    { label: "Filter phone lines", shortcut: "/", description: "Find lines by name or phone number.", run: openFilter },
    { label: "Clear the line filter", shortcut: "Ctrl+U", description: "Show all lines allowed by your exclusions.", run: () => updateSettings({ filter: "" }) },
    { label: "Switch to the next account", shortcut: "Tab", description: "Cycle through all accounts together and each account individually.", run: () => stepFocus(1) },
    { label: "Exclude outside numbers", shortcut: "X", description: "Leave test phones and other outside numbers out of your totals.", run: () => setExclusions({ open: true, cursor: 0, adding: false, input: "" }) },
    { label: `Change traffic direction: ${directionNames[direction]}`, shortcut: "D", description: "Cycle through all traffic, incoming only, and outgoing only.", run: nextDirection },
    { label: `Change chart style: ${chartType}`, shortcut: "T", description: "Cycle through line, bars, sparklines, and a table using the selected daily or weekly grouping.", run: nextChart },
    { label: `Change time zone: ${timeZone.toUpperCase()}`, shortcut: "Z", description: "Switch day boundaries between UTC and your local time.", run: toggleTimeZone },
    { label: "Export this view to CSV", shortcut: "E", description: "Save counts and coverage for the selected accounts and dates.", run: exportCsv },
    { label: "Refresh recent traffic", shortcut: "R", description: "Refresh recent data; older windows show saved traffic.", run: () => setRefreshKey((value) => value + 1) },
    { label: "Keyboard help", shortcut: "?", description: "Read all shortcuts, including alternatives for compact Mac keyboards.", run: () => setHelpOpen(true) },
    { label: "Quit", shortcut: "Q", description: "Close the dashboard.", run: () => renderer.destroy() },
  ].map((action) => ({ ...action, run: () => { setActionsOpen(false); action.run(); } }));

  useKeyboard((key) => {
    const enterPressed = key.name === "enter" || key.name === "return" || key.sequence === "\r";

    if (windowOpen || actionsOpen || viewsOpen || openedEvent) return;
    if (downloadsOpen) {
      if (downloadEdit !== null) {
        if (key.name === "escape") setDownloadEdit(null);
        else if (enterPressed) applyDownloadDate();
        else if (key.name === "backspace") setDownloadEdit((value) => value!.slice(0, -1));
        else if (key.ctrl && key.name === "u") setDownloadEdit("");
        else { const character = typedCharacter(key); if (character) setDownloadEdit((value) => value + character); }
        return;
      }
      if (key.name === "escape" || key.name === "b" || key.name === "q") { setDownloadsOpen(false); setDownloadDraft(null); }
      else if (key.name === "up" || key.name === "k") setDownloadCursor((value) => Math.max(0, value - 1));
      else if (key.name === "down" || key.name === "j") setDownloadCursor((value) => Math.min(downloadAccounts.length - 1, value + 1));
      else if (key.name === "space" || enterPressed) toggleDownload(downloadAccounts[Math.min(downloadCursor, downloadAccounts.length - 1)]!);
      else if (key.name === "s") runDownloads();
      else if (key.name === "g") setDownloadEdit(downloadOptions.startDay ?? "");
      else if (key.name === "i") changePace();
      return;
    }
    if (picker.open) {
      if (forgetId !== null) {
        if (key.name === "y") confirmForget();
        else if (key.name === "escape" || key.name === "n") setForgetId(null);
        return;
      }
      const profile = pickerProfiles[picker.cursor];
      if (key.name === "escape") setPicker((current) => ({ ...current, open: false }));
      else if (key.name === "r") setPicker((current) => ({ ...current, loadKey: current.loadKey + 1 }));
      else if (key.name === "up" || key.name === "k") setPicker((current) => ({ ...current, cursor: Math.max(0, current.cursor - 1) }));
      else if (key.name === "down" || key.name === "j") setPicker((current) => ({ ...current, cursor: Math.min(Math.max(0, pickerProfiles.length - 1), current.cursor + 1) }));
      else if ((key.name === "space" || enterPressed) && profile) {
        toggleProfile(profile.id);
      } else if (key.name === "a") setPicker((current) => ({ ...current, draft: pickerProfiles.filter((entry) => !entry.disconnected).map((entry) => entry.id) }));
      else if ((key.name === "f" || key.name === "backspace") && profile) setForgetId(profile.id);
      else if (key.name === "c") setPicker((current) => ({ ...current, draft: [] }));
      else if (key.name === "d") applyAccounts();
      return;
    }

    if (exclusions.open) {
      if (exclusions.adding) {
        if (key.name === "escape") setExclusions((current) => ({ ...current, adding: false, input: "" }));
        else if (enterPressed) addExcluded();
        else if (key.name === "backspace") setExclusions((current) => ({ ...current, input: current.input.slice(0, -1) }));
        else if (key.ctrl && key.name === "u") setExclusions((current) => ({ ...current, input: "" }));
        else {
          const character = typedCharacter(key);
          if (character) setExclusions((current) => ({ ...current, input: current.input + character }));
        }
        return;
      }
      const row = peerRows[exclusions.cursor];
      if (key.name === "escape" || key.name === "x" || key.name === "q") setExclusions((current) => ({ ...current, open: false }));
      else if (key.name === "up" || key.name === "k") setExclusions((current) => ({ ...current, cursor: Math.max(0, current.cursor - 1) }));
      else if (key.name === "down" || key.name === "j") setExclusions((current) => ({ ...current, cursor: Math.min(Math.max(0, peerRows.length - 1), current.cursor + 1) }));
      else if ((key.name === "space" || enterPressed) && row) toggleExcluded(row.number);
      else if (key.name === "backspace" && row?.excluded) toggleExcluded(row.number);
      else if (key.name === "n") setExclusions((current) => ({ ...current, adding: true, input: "" }));
      return;
    }

    if (filterEdit.editing) {
      if (key.name === "escape") setFilterEdit({ editing: false, draft: "", fresh: false });
      else if (enterPressed) applyFilter();
      else if (key.name === "backspace") setFilterEdit((current) => ({ ...current, draft: current.draft.slice(0, -1), fresh: false }));
      else if (key.ctrl && key.name === "u") setFilterEdit((current) => ({ ...current, draft: "", fresh: false }));
      else if (key.name === "right" || key.name === "end") setFilterEdit((current) => ({ ...current, fresh: false }));
      else {
        const character = typedCharacter(key);
        if (character) setFilterEdit((current) => ({ ...current, draft: (current.fresh ? "" : current.draft) + character, fresh: false }));
      }
      return;
    }

    if (helpOpen) {
      if (key.name === "escape" || key.sequence === "?" || key.name === "q") setHelpOpen(false);
      else if (key.name === "space") { setHelpOpen(false); setActionsOpen(true); }
      return;
    }
    if (key.sequence === "?") {
      setHelpOpen(true);
      return;
    }
    if (key.name === "space") { setActionsOpen(true); return; }
    if (key.sequence === "/") {
      openFilter();
      return;
    }
    if (key.ctrl && key.name === "u") {
      updateSettings({ filter: "" });
      return;
    }
    if (key.name === "p") {
      openAccounts();
      return;
    }
    if (key.name === "x") {
      setExclusions({ open: true, cursor: 0, adding: false, input: "" });
      return;
    }
    if (key.name === "escape" || key.name === "backspace") {
      if (activityRange) setActivityRange(null);
      else if (detail) closeDetail();
      else if (activityOpen) setActivityOpen(false);
      return;
    }
    if (key.name === "q") renderer.destroy();
    if (key.sequence === "<" || key.sequence === ">") {
      const target = new Date(`${endDay}T12:00:00Z`);
      const day = target.getUTCDate();
      target.setUTCDate(1);
      target.setUTCMonth(target.getUTCMonth() + (key.sequence === "<" ? -1 : 1));
      const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
      target.setUTCDate(Math.min(day, lastDay));
      const next = dayKey(target, "utc");
      setPeriod(period);
      setWindowEnd(next >= dayKey(new Date(), timeZone) ? null : next);
    }
    if (key.sequence === ",") moveWindow(-7);
    if (key.sequence === ".") moveWindow(7);
    if (key.sequence === "-") moveWindow(-period);
    if (key.sequence === "=" || key.sequence === "+") moveWindow(period);
    if (key.name === "pageup") { if (activityOpen) setActivityCursor((value) => Math.max(0, value - 10)); else moveWindow(-period); }
    if (key.name === "pagedown") { if (activityOpen) setActivityCursor((value) => Math.min(Math.max(0, activityEvents.length - 1), value + 10)); else moveWindow(period); }
    if (key.name === "h") setWindowEnd(null);
    if (key.name === "w") setWindowOpen(true);
    if (key.name === "s") setViewsOpen(true);
    if (key.name === "c") toggleCumulative();
    if (key.name === "i") toggleChartInterval();
    if (key.name === "n") setUnique((value) => !value);
    if (key.name === "g") setChartVisible((value) => !value);
    if (key.name === "v") setActivityOpen((value) => !value);
    if (key.name === "m") setActivityKind((value) => value === "all" ? "message" : value === "message" ? "call" : "all");
    if (key.name === "r") {
      if (key.shift) { clearCache(); setLoaded(null); }
      setRefreshKey((current) => current + 1);
    }
    if (key.name === "b") setDownloadsOpen(true);
    if (key.name === "u" && !key.ctrl) previewWindowDownload();
    if (key.name === "e") exportCsv();
    if (key.name === "z") toggleTimeZone();
    if (key.name === "d") nextDirection();
    if (key.name === "0") setPeriod(1);
    if (key.name === "1") setPeriod(7);
    if (key.name === "2") setPeriod(30);
    if (key.name === "3") setPeriod(90);
    if (key.name === "4") setPeriod(180);
    if (key.name === "5") setPeriod(365);
    if (key.name === "6") setPeriod(730);
    if (key.name === "left" || key.name === "right") {
      const next = key.name === "left" ? [...periods].reverse().find((days) => days < period) : periods.find((days) => days > period);
      setPeriod(next ?? (key.name === "left" ? periods[0]! : periods.at(-1)!));
    }
    if (key.name === "t") nextChart();
    if (key.name === "tab") stepFocus(key.shift ? -1 : 1);
    if (key.sequence === "]") stepFocus(1);
    if (key.sequence === "[") stepFocus(-1);
    if (key.name === "a") setFocus(null);
    if (key.name === "up" || key.name === "k") { if (activityOpen) setActivityCursor((value) => Math.max(0, value - 1)); else moveCursor(-1); }
    if (key.name === "down" || key.name === "j") { if (activityOpen) setActivityCursor((value) => Math.min(Math.max(0, activityEvents.length - 1), value + 1)); else moveCursor(1); }
    if (enterPressed) {
      if (activityOpen) setOpenedEvent(activityEvents[Math.min(activityCursor, activityEvents.length - 1)] ?? null);
      else openDetail(lines[cursorIndex]);
    }
  });

  if (actionsOpen) return <ActionsScreen actions={menuActions} width={width} height={height} onClose={() => setActionsOpen(false)} />;

  if (openedEvent) return <EventDetailScreen event={openedEvent} width={width} timeZone={timeZone} onClose={() => setOpenedEvent(null)} />;

  if (viewsOpen) return <SavedViewsScreen views={settings.views ?? []} width={width} height={height}
    onSave={saveView} onLoad={loadView} onRemove={(name) => updateSettings({ views: (settings.views ?? []).filter((view) => view.name !== name) })}
    onClose={() => setViewsOpen(false)} />;

  if (windowOpen) return <WindowScreen start={shiftDay(endDay, -(period - 1))} end={endDay} timeZone={timeZone} preset={calendarPreset}
    onClose={() => setWindowOpen(false)} onApply={(days, end, preset) => { setPeriod(days); setCalendarPreset(preset ?? null); setWindowEnd(end === dayKey(new Date(), timeZone) ? null : end); setWindowOpen(false); }} />;

  if (downloadsOpen) return <DownloadsScreen accounts={downloadAccounts} selected={downloadSelected} cursor={downloadCursor}
    paused={!!downloadDraft || settings.importPaused !== false} options={downloadOptions} progress={downloadDraft ? null : importProgress} editing={downloadEdit}
    preview={!!downloadDraft}
    plan={downloadOptions.startDay && downloadOptions.endDay ? downloadWindowPlan(downloadSelected, { from: downloadOptions.startDay, through: downloadOptions.endDay }, downloadOptions.intervalMinutes ?? 10) : undefined}
    notice={notice?.text ?? null} width={width} height={height}
    onToggle={(id) => { setDownloadCursor(downloadAccounts.indexOf(id)); toggleDownload(id); }}
    onRun={runDownloads}
    onTarget={() => setDownloadEdit(downloadOptions.startDay ?? "")} onPace={changePace}
    onApplyDate={applyDownloadDate} onCancelDate={() => setDownloadEdit(null)}
    onScroll={(step) => setDownloadCursor((value) => Math.max(0, Math.min(downloadAccounts.length - 1, value + step)))}
    onClose={() => { setDownloadsOpen(false); setDownloadDraft(null); setDownloadEdit(null); }} />;

  if (picker.open) {
    return (
      <ProfilePicker
        profiles={pickerProfiles}
        selected={picker.draft}
        cursor={picker.cursor}
        loading={picker.loading}
        error={picker.error}
        height={height}
        width={width}
        confirmForget={forgetId}
        notice={notice?.text ?? null}
        onToggle={(id) => { toggleProfile(id); setPicker((current) => ({ ...current, cursor: pickerProfiles.findIndex((profile) => profile.id === id) })); }}
        onDone={applyAccounts} onCancel={() => setPicker((current) => ({ ...current, open: false }))}
        onForget={() => { if (pickerProfiles[picker.cursor]) setForgetId(pickerProfiles[picker.cursor]!.id); }}
        onConfirmForget={confirmForget} onCancelForget={() => setForgetId(null)}
        onScroll={(step) => setPicker((current) => ({ ...current, cursor: Math.max(0, Math.min(pickerProfiles.length - 1, current.cursor + step)) }))}
        onAll={() => setPicker((current) => ({ ...current, draft: pickerProfiles.filter((entry) => !entry.disconnected).map((entry) => entry.id) }))}
        onActive={() => setPicker((current) => ({ ...current, draft: [] }))}
        onReload={() => setPicker((current) => ({ ...current, loadKey: current.loadKey + 1 }))}
      />
    );
  }

  if (exclusions.open) {
    return (
      <ExclusionsScreen
        peers={data?.peers ?? []}
        excluded={settings.excluded}
        cursor={exclusions.cursor}
        input={exclusions.input}
        adding={exclusions.adding}
        height={height}
        width={width}
        onToggle={(number, cursor) => { setExclusions((current) => ({ ...current, cursor })); toggleExcluded(number); }}
        onAdd={() => setExclusions((current) => ({ ...current, adding: true, input: "" }))}
        onApply={addExcluded} onCancelAdd={() => setExclusions((current) => ({ ...current, adding: false, input: "" }))}
        onClose={() => setExclusions((current) => ({ ...current, open: false, adding: false, input: "" }))}
        onScroll={(step) => setExclusions((current) => ({ ...current, cursor: Math.max(0, Math.min(peerRows.length - 1, current.cursor + step)) }))}
      />
    );
  }

  // The detail line keeps its label even when it has no traffic in the current range.
  const detailEntry = detail ? lines.find((entry) => entry.key === detail.key) ?? null : null;
  const rows = data?.rows ?? [];
  const viewRows = detail
    ? rows.map((row) => ({ ...(detailEntry?.daily[row.date] ?? { date: row.date, ...emptyCounts() }), coverage: row.coverage, inProgress: row.inProgress }))
    : rows;
  const currentComplete = !!data && data.coverage.current.complete === period;
  const comparisonComplete = !unique && !!data && data.coverage.previous.complete === period;
  const compare = (value: number, previous: number) => currentComplete && comparisonComplete ? percentChange(value, previous) : undefined;
  const observed = (value: number) => `${currentComplete ? "" : "≥"}${formatNumber(value)}`;
  const counts = uniqueView?.totals ?? (detail ? detailEntry ?? emptyCounts() : data?.totals ?? emptyCounts());
  const previous = detail ? detailEntry?.previous ?? emptyCounts() : data?.previous ?? emptyCounts();
  const current = pick(counts, unique ? "in" : direction);
  const prior = pick(previous, direction);
  const total = totalOf(counts, unique ? "in" : direction);
  const activeDays = viewRows.filter((row) => totalOf(row, direction) > 0).length;
  const activeLines = lines.filter((line) => totalOf(line, direction) > 0).length;
  const destinationLabel = detail
    ? [detail.profile && accounts.length > 1 ? detail.profile : "", detail.name ?? "", detail.number].filter(Boolean).join(" · ")
    : settings.filter ? `LINES MATCHING "${settings.filter}"` : "ALL LINES";
  const profileErrors = data?.errors ?? [];

  // Layout: fixed chrome, then the chart and line table share all remaining space.
  const cards = width >= 120 && height >= 30;
  const showAccountBar = accounts.length > 1;
  const showFilterBar = filterEdit.editing || !!settings.filter || settings.excluded.length > 0;
  const messages: Array<{ text: string; color: string }> = [];
  if (unique) messages.push({ text: detail ? "UNIQUE: each number counted once across calls and texts."
    : "UNIQUE: once across lines, accounts & channels; line counts may overlap.", color: theme.muted });
  if (data) {
    const coverage = data.coverage.current;
    messages.push({ text: `DATA ${coverage.complete}/${period} days complete · ${coverage.partial} partial · ${coverage.missing} missing${currentComplete ? "" : " · ≥ observed counts · U download window"}`, color: currentComplete ? theme.cyan : theme.amber });
    if (!unique && !comparisonComplete) messages.push({ text: `COMPARISON ${data.coverage.previous.complete}/${period} days complete · Δ unavailable until both windows are complete`, color: theme.amber });
  }
  if (error) messages.push({ text: loaded ? `Refresh failed, showing last data: ${error}` : error, color: theme.red });
  for (const entry of profileErrors) messages.push({ text: `Account ${entry.profile ?? "active"} refresh failed; saved traffic shown if available: ${entry.message}`, color: theme.amber });
  if (detail && !detailEntry && data) messages.push({ text: `${detail.number} is not in the current view.`, color: theme.muted });
  const showDownloadStatus = settings.importPaused === false && runningProfiles.length > 0;
  const chromeHeight = 4 + (showAccountBar ? 1 : 0) + (showFilterBar ? 1 : 0) + (cards ? 4 : 1) + messages.length + Number(showDownloadStatus) + Number(!!notice);
  const bodyHeight = Math.max(8, height - chromeHeight);
  const splitBody = wide && chartVisible;
  const tableWidth = splitBody ? innerWidth - chartWidth - 1 : innerWidth;
  const chartHeight = !chartVisible ? 0 : splitBody ? bodyHeight : Math.min(bodyHeight - 5, Math.max(6, Math.round(bodyHeight * (detail ? 0.62 : 0.5))));
  const tableHeight = !chartVisible || splitBody ? bodyHeight : Math.max(5, bodyHeight - chartHeight);

  const updated = lastUpdated ? lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
  const status = historyDays > 0
    ? { text: "● SAVED HISTORY", color: theme.cyan }
    : loading
    ? { text: loaded ? "● SYNCING" : "● LOADING", color: theme.amber }
    : error || profileErrors.length > 0
      ? { text: `● STALE · ${updated}`, color: theme.red }
      : { text: `● SAVED · ${updated}`, color: theme.cyan };
  const scopeLabel = detail ? `${detail.number}${detail.profile ? ` · ${detail.profile}` : ""}`
    : focus ? `account ${focus}` : accounts.length > 1 ? `all ${accounts.length} accounts` : accountLabelFor(accounts);

  const directionDetail = unique ? "distinct phone numbers" : direction === "both" ? `${formatNumber(pick(counts, "in").messages)} in · ${formatNumber(pick(counts, "out").messages)} out` : "selected dates";
  const callDetail = unique ? "distinct phone numbers" : direction === "both" ? `${formatNumber(pick(counts, "in").calls)} in · ${formatNumber(pick(counts, "out").calls)} out` : "selected dates";
  const uniqueTextTitle = direction === "in" ? "UNIQUE TEXTERS" : "UNIQUE TEXT CONTACTS";
  const uniqueCallTitle = direction === "in" ? "UNIQUE CALLERS" : "UNIQUE CALL CONTACTS";
  const uniqueTextLabel = direction === "in" ? "TEXTERS" : "TEXT #";
  const uniqueCallLabel = direction === "in" ? "CALLERS" : "CALL #";
  const metricValues = [
    { title: unique ? uniqueTextTitle : direction === "in" ? "TEXTS RECEIVED" : direction === "out" ? "TEXTS SENT" : "TEXTS", label: unique ? uniqueTextLabel : direction === "in" ? "TEXTS IN" : direction === "out" ? "TEXTS OUT" : "TEXTS", value: observed(current.messages), color: theme.cyan, detail: directionDetail, delta: compare(current.messages, prior.messages) },
    { title: unique ? uniqueCallTitle : direction === "in" ? "CALLS RECEIVED" : direction === "out" ? "CALLS MADE" : "CALLS", label: unique ? uniqueCallLabel : direction === "in" ? "CALLS IN" : direction === "out" ? "CALLS OUT" : "CALLS", value: observed(current.calls), color: theme.violet, detail: callDetail, delta: compare(current.calls, prior.calls) },
    { title: unique ? "UNIQUE CONTACTS" : "TOTAL EVENTS", label: unique ? "CONTACTS" : "EVENTS", value: observed(total), color: theme.ink, detail: unique ? "both channels, counted once" : "texts + calls", delta: compare(total, prior.messages + prior.calls) },
    detail
      ? { title: "ACTIVE DAYS", label: "ACTIVE", value: `${activeDays}/${viewRows.length}`, color: theme.amber, detail: "with traffic", delta: undefined }
      : { title: "LINES", label: "LINES", value: `${formatNumber(activeLines)}/${formatNumber(lines.length)}`, color: theme.amber, detail: "with traffic", delta: undefined },
  ];

  const importPercent = importProgress?.phase === "complete" ? 100 : importProgress?.total ? Math.floor(importProgress.completed * 100 / importProgress.total) : 0;
  const filled = Math.floor(importPercent / 10);
  const importBar = `[${"━".repeat(filled)}${"─".repeat(10 - filled)}]`;
  const importLabel = settings.importPaused || !downloadSelected.length
    ? "HISTORY DOWNLOADS · PAUSED"
    : `${importBar} ${importPercent}% HISTORY DOWNLOADS · ${importProgress?.phase ?? "starting"}`;

  const visiblePeriods = width >= 110 ? periods : [7, 30, 90];

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background} paddingX={1}>
      <box height={1} flexDirection="row" justifyContent="space-between">
        <text wrapMode="none">
          <span fg={theme.cyan}><strong>TWILIO</strong></span>
          <span fg={theme.muted}>-</span>
          <span fg={theme.ink}><strong>TUI</strong></span>
          <span fg={theme.muted}>   {clipText(scopeLabel, Math.max(8, innerWidth - 58))}</span>
        </text>
        <box flexDirection="row" flexShrink={0}>
          <Tab label={unique ? "N Unique contacts" : "N Events"} active={unique} onClick={() => setUnique((value) => !value)} />
          <text fg={status.color} wrapMode="none"> {status.text}</text>
        </box>
      </box>

      {showAccountBar && (
        <box height={1} flexDirection="row" gap={1}>
          <text fg={theme.muted} wrapMode="none">ACCOUNT</text>
          <Tab label={`ALL ${accounts.length}`} active={!focus} onClick={() => setFocus(null)} />
          {accounts.map((account) => (
            <Tab key={account} label={account} active={focus === account} onClick={() => setFocus(account)} />
          ))}
          <text fg={theme.dim} wrapMode="none">  Tab switch</text>
        </box>
      )}

      <box height={1} flexDirection="row" justifyContent="space-between">
        <box flexDirection="row" gap={1}>
          {directions.map((mode) => (
            <Tab key={mode} label={directionNames[mode]} active={direction === mode} onClick={() => setDirection(mode)} accent={theme.violet} />
          ))}
          {detail && <Tab label="◂ BACK" active={false} onClick={closeDetail} />}
        </box>
        <box flexDirection="row" gap={1}>
          {visiblePeriods.map((days) => <Tab key={days} label={days === 365 ? "1Y" : days === 730 ? "2Y" : `${days}D`} active={!calendarPreset && period === days} onClick={() => setPeriod(days)} />)}
          {width >= 140 && (["mtd", "qtd"] as const).map((preset) => <Tab key={preset} label={preset.toUpperCase()} active={calendarPreset === preset} onClick={() => chooseCalendarPreset(preset)} />)}
          <Tab label="Dates…" active={!!calendarPreset || !visiblePeriods.includes(period)} onClick={() => setWindowOpen(true)} />
          <Tab label={timeZone.toUpperCase()} active={false} onClick={toggleTimeZone} />
        </box>
      </box>

      <box height={1} flexDirection="row" gap={1}>
        <Tab label="Older" active={false} onClick={() => moveWindow(-period)} />
        <Tab label={`${calendarPreset ? `${calendarPreset.toUpperCase()} · ` : ""}${shiftDay(endDay, -(period - 1))} → ${endDay}`} active={false} onClick={() => setWindowOpen(true)} />
        <Tab label="Newer" active={false} onClick={() => moveWindow(period)} />
        <Tab label="Today" active={false} onClick={() => setWindowEnd(null)} />
        <Tab label={activityOpen ? "Lines" : "Activity"} active={activityOpen} onClick={() => setActivityOpen((value) => !value)} />
        <Tab label={chartVisible ? "G Hide chart" : "G Show chart"} active={false} onClick={() => setChartVisible((value) => !value)} />
      </box>

      {showFilterBar && (
        <box height={1} flexDirection="row" justifyContent="space-between" backgroundColor={filterEdit.editing ? theme.selection : undefined}>
          <text wrapMode="none">
            <span fg={theme.cyan}><strong>FILTER </strong></span>
            {filterEdit.editing ? (
              <>
                <span fg={filterEdit.fresh ? theme.background : theme.ink} bg={filterEdit.fresh ? theme.cyan : undefined}>{clipText(filterEdit.draft, Math.max(5, innerWidth - 34))}</span>
                <span fg={theme.cyan}>▏</span>
              </>
            ) : (
              <>
                <span fg={settings.filter ? theme.ink : theme.dim}>{clipText(`${settings.filter || "none"} · ${settings.excluded.length} excluded`, Math.max(5, innerWidth - 43))}</span>
              </>
            )}
          </text>
          <box flexDirection="row" flexShrink={0}>
            {filterEdit.editing ? <>
              <Tab label="Apply" active onClick={applyFilter} />
              <Tab label="Cancel" active={false} onClick={() => setFilterEdit({ editing: false, draft: "", fresh: false })} />
              <Tab label="Clear" active={false} onClick={() => setFilterEdit((current) => ({ ...current, draft: "", fresh: false }))} />
            </> : <>
              <Tab label="Edit filter" active={false} onClick={openFilter} />
              <Tab label="Clear" active={false} onClick={() => updateSettings({ filter: "" })} />
              <Tab label="X exclusions" active={false} onClick={() => setExclusions({ open: true, cursor: 0, adding: false, input: "" })} />
            </>}
          </box>
        </box>
      )}

      {cards ? (
        <box height={4} flexDirection="row" gap={1}>
          {metricValues.map((metric) => (
            <MetricCard key={metric.title} title={metric.title} value={metric.value} color={metric.color} detail={metric.detail} delta={metric.delta} />
          ))}
        </box>
      ) : (
        <MetricStrip values={metricValues.map((metric) => ({ label: metric.label, value: metric.value, color: metric.color, delta: metric.delta }))} />
      )}

      {messages.map((message, index) => (
        <text key={index} fg={message.color} wrapMode="none" onMouseDown={message.text.includes("U download window") ? previewWindowDownload : undefined}>{clipText(message.text, innerWidth)}</text>
      ))}

      <box flexDirection={splitBody ? "row" : "column"} gap={splitBody ? 1 : 0} height={bodyHeight}>
        {chartVisible && <TrafficChart
          rows={viewRows}
          previous={previous}
          direction={direction}
          width={chartWidth}
          height={chartHeight}
          title={`${detail ? "CAMPAIGN · " : ""}${destinationLabel} · ${calendarPreset ? `${calendarPreset.toUpperCase()} · ` : ""}${period} DAYS${historyDays ? ` TO ${endDay}` : ""} (${timeZone.toUpperCase()})`}
          chartType={chartType}
          timeZone={timeZone}
          cumulative={cumulative}
          unique={uniqueView}
          interval={chartInterval}
          comparisonComplete={comparisonComplete}
          onToggleMode={toggleCumulative}
          onToggleInterval={toggleChartInterval}
          onNextChart={nextChart}
          onDownload={previewWindowDownload}
          onChooseDates={() => setWindowOpen(true)}
          onShowActivity={() => { setActivityRange(null); setActivityKind("all"); setActivityOpen(true); }}
          onSelectRange={(from, through) => { setActivityRange({ from, through }); setActivityKind("all"); setActivityCursor(0); setActivityOpen(true); }}
        />}
        {activityOpen ? <ActivityTable events={activityEvents} direction={direction} timeZone={timeZone} width={tableWidth} height={tableHeight}
          cursor={activityCursor} kind={activityKind} onKind={setActivityKind}
          range={activityRange} onClearRange={() => setActivityRange(null)} onSelect={setActivityCursor}
          onShowLines={() => setActivityOpen(false)}
          onOpen={setOpenedEvent}
          onScroll={(step) => setActivityCursor((value) => Math.max(0, Math.min(activityEvents.length - 1, value + step)))} /> : <LineTable
          lines={lines}
          dates={rows.map((row) => row.date)}
          direction={unique ? "in" : direction}
          unique={unique}
          loaded={!!data}
          width={tableWidth}
          height={tableHeight}
          cursorIndex={cursorIndex}
          detailKey={detail?.key ?? null}
          showProfile={!focus && accounts.length > 1}
          filter={settings.filter}
          filteredOut={data?.filteredOut ?? 0}
          complete={currentComplete}
          comparisonComplete={comparisonComplete}
          coverageRows={rows}
          onRowClick={(index) => openDetail(lines[index])}
          onScroll={(step) => { if (step) moveCursor(step > 0 ? 1 : -1); }}
        />}
      </box>

      {showDownloadStatus && <box height={1} flexDirection="row" justifyContent="space-between" onMouseDown={() => setDownloadsOpen(true)}>
        <text fg={settings.importPaused ? theme.muted : importProgress?.phase === "retrying" ? theme.amber : theme.cyan} wrapMode="none">{clipText(importLabel, innerWidth - 10)}</text>
        <text fg={theme.cyan} wrapMode="none">{"B downloads"}</text>
      </box>}
      {notice && <text height={1} fg={notice.error ? theme.red : theme.green} wrapMode="none">{clipText(notice.text, innerWidth)}</text>}
      <box height={1} flexDirection="row" gap={1}>
        <Tab label="Actions" active={false} onClick={() => { setHelpOpen(false); setActionsOpen(true); }} />
        <Tab label="W dates" active={false} onClick={() => setWindowOpen(true)} />
        <Tab label={activityOpen ? "V lines" : "V activity"} active={activityOpen} onClick={() => setActivityOpen((value) => !value)} />
        <Tab label="B downloads" active={false} onClick={() => setDownloadsOpen(true)} />
        <Tab label="P accounts" active={false} onClick={openAccounts} />
        {width >= 100 && <Tab label="S views" active={false} onClick={() => setViewsOpen(true)} />}
        <Tab label="? help" active={helpOpen} onClick={() => setHelpOpen(true)} />
        <Tab label="Q quit" active={false} onClick={() => renderer.destroy()} />
      </box>

      {helpOpen && <HelpOverlay width={width} height={height} onClose={() => setHelpOpen(false)} onActions={() => { setHelpOpen(false); setActionsOpen(true); }} />}
    </box>
  );
}
