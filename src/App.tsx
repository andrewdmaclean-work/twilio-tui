import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import {
  accountLabelFor,
  buildDashboard,
  cachedSources,
  clearCache,
  dashboardCsv,
  emptyCounts,
  fetchSources,
  listCliProfiles,
  loadSettings,
  numberMatchKey,
  pick,
  saveSettings,
  selectedProfiles,
  totalOf,
  type CliProfile,
  type DirectionMode,
  type LineTraffic,
  type LoadedSources,
  type Period,
  type Settings,
  type TimeZoneMode,
} from "./data";
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

const periods: Period[] = [7, 30, 90];
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
  const [period, setPeriod] = useState<Period>(30);
  const [timeZone, setTimeZone] = useState<TimeZoneMode>("utc");
  const [direction, setDirection] = useState<DirectionMode>("both");
  const [chartType, setChartType] = useState<ChartType>("line");
  const [refreshKey, setRefreshKey] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);

  // Persisted: which accounts are loaded, which one is in focus (null = all), the line filter and exclusions.
  const [settings, setSettings] = useState<Settings>({ profiles: selectedProfiles, focus: null, filter: "", excluded: [] });
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

  const updateSettings = (change: Partial<Settings>) => {
    setSettings((current) => {
      const next = { ...current, ...change };
      void saveSettings(next).catch((reason) => showNotice(`Could not save settings: ${errorMessage(reason)}`, true));
      return next;
    });
  };

  const showNotice = (text: string, isError = false) => setNotice({ text, error: isError });

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.error ? 10_000 : 5_000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    let cancelled = false;
    void loadSettings().then((saved) => {
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
    const cached = cachedSources(period, requestProfiles);
    if (cached) setLoaded((current) => ({ sources: cached, errors: current?.errors ?? [] }));

    const load = async () => {
      if (controller) return;
      controller = new AbortController();
      setLoading(true);
      try {
        const next = await fetchSources(period, requestProfiles, { signal: controller.signal });
        if (disposed) return;
        setLoaded(next);
        setError(null);
        setLastUpdated(new Date());
      } catch (reason) {
        if (!disposed) setError(errorMessage(reason));
      } finally {
        controller = null;
        if (!disposed) setLoading(false);
      }
    };

    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => {
      disposed = true;
      clearInterval(timer);
      controller?.abort();
    };
  }, [period, refreshKey, accountsKey, settingsReady]);

  const data = useMemo(() => {
    if (!loaded) return null;
    const sources = focus ? loaded.sources.filter((source) => source.profile === focus) : loaded.sources;
    const errors = focus ? loaded.errors.filter((entry) => entry.profile === focus) : loaded.errors;
    return buildDashboard(sources, period, timeZone, { errors, filter: settings.filter, excluded: settings.excluded });
  }, [loaded, focus, period, timeZone, settings.filter, settings.excluded]);

  const lines = useMemo(() => {
    const all = data?.lines ?? [];
    return [...all].sort((a, b) => totalOf(b, direction) - totalOf(a, direction)
      || (a.name ?? "￿").localeCompare(b.name ?? "￿")
      || a.key.localeCompare(b.key));
  }, [data, direction]);
  const foundIndex = cursorKey ? lines.findIndex((entry) => entry.key === cursorKey) : -1;
  const cursorIndex = foundIndex >= 0 ? foundIndex : Math.max(0, Math.min(lastCursorIndex.current, lines.length - 1));
  lastCursorIndex.current = cursorIndex;

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

  const exportCsv = () => {
    if (!data) {
      showNotice("Waiting for data before CSV export");
      return;
    }
    const file = exportFileName();
    void Bun.write(file, dashboardCsv(data))
      .then(() => showNotice(`Exported ${file}`))
      .catch((reason) => showNotice(`CSV export failed: ${errorMessage(reason)}`, true));
  };

  useKeyboard((key) => {
    const enterPressed = key.name === "enter" || key.name === "return" || key.sequence === "\r";

    if (picker.open) {
      const profile = picker.available[picker.cursor];
      if (key.name === "escape") setPicker((current) => ({ ...current, open: false }));
      else if (key.name === "r") setPicker((current) => ({ ...current, loadKey: current.loadKey + 1 }));
      else if (key.name === "up" || key.name === "k") setPicker((current) => ({ ...current, cursor: Math.max(0, current.cursor - 1) }));
      else if (key.name === "down" || key.name === "j") setPicker((current) => ({ ...current, cursor: Math.min(Math.max(0, current.available.length - 1), current.cursor + 1) }));
      else if ((key.name === "space" || enterPressed) && profile) {
        setPicker((current) => ({
          ...current,
          draft: current.draft.includes(profile.id) ? current.draft.filter((id) => id !== profile.id) : [...current.draft, profile.id],
        }));
      } else if (key.name === "a") setPicker((current) => ({ ...current, draft: current.available.map((entry) => entry.id) }));
      else if (key.name === "c") setPicker((current) => ({ ...current, draft: [] }));
      else if (key.name === "d") {
        setDetail(null);
        updateSettings({ profiles: [...picker.draft], focus: picker.draft.includes(focus ?? "") ? focus : null });
        setPicker((current) => ({ ...current, open: false }));
      }
      return;
    }

    if (exclusions.open) {
      if (exclusions.adding) {
        if (key.name === "escape") setExclusions((current) => ({ ...current, adding: false, input: "" }));
        else if (enterPressed) {
          const number = exclusions.input.trim();
          if (number && !settings.excluded.some((entry) => numberMatchKey(entry) === numberMatchKey(number))) {
            updateSettings({ excluded: [...settings.excluded, number] });
          }
          setExclusions((current) => ({ ...current, adding: false, input: "", cursor: 0 }));
        } else if (key.name === "backspace") setExclusions((current) => ({ ...current, input: current.input.slice(0, -1) }));
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
      else if (enterPressed) {
        setFilterEdit({ editing: false, draft: "", fresh: false });
        setDetail(null);
        updateSettings({ filter: filterEdit.draft.trim() });
      } else if (key.name === "backspace") setFilterEdit((current) => ({ ...current, draft: current.draft.slice(0, -1), fresh: false }));
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
      return;
    }
    if (key.sequence === "?") {
      setHelpOpen(true);
      return;
    }
    if (key.sequence === "/") {
      setFilterEdit({ editing: true, draft: settings.filter, fresh: !!settings.filter });
      return;
    }
    if (key.ctrl && key.name === "u") {
      updateSettings({ filter: "" });
      return;
    }
    if (key.name === "p") {
      setPicker((current) => ({ ...current, open: true, draft: accounts, cursor: 0 }));
      return;
    }
    if (key.name === "x") {
      setExclusions({ open: true, cursor: 0, adding: false, input: "" });
      return;
    }
    if (key.name === "escape" || key.name === "backspace") {
      if (detail) setDetail(null);
      else if (key.name === "escape") renderer.destroy();
      return;
    }
    if (key.name === "q") renderer.destroy();
    if (key.name === "r") {
      if (key.shift) {
        clearCache();
        setLoaded(null);
      }
      setRefreshKey((current) => current + 1);
    }
    if (key.name === "e") exportCsv();
    if (key.name === "z") setTimeZone((current) => current === "utc" ? "local" : "utc");
    if (key.name === "d") setDirection((current) => directions[(directions.indexOf(current) + 1) % directions.length]!);
    if (key.name === "1") setPeriod(7);
    if (key.name === "2") setPeriod(30);
    if (key.name === "3") setPeriod(90);
    if (key.name === "left" || key.name === "right") {
      const current = periods.indexOf(period);
      setPeriod(periods[key.name === "left" ? Math.max(0, current - 1) : Math.min(periods.length - 1, current + 1)]!);
    }
    if (key.name === "t") setChartType((current) => chartTypes[(chartTypes.indexOf(current) + 1) % chartTypes.length]!);
    if (key.name === "tab") stepFocus(key.shift ? -1 : 1);
    if (key.sequence === "]") stepFocus(1);
    if (key.sequence === "[") stepFocus(-1);
    if (key.name === "a") setFocus(null);
    if (key.name === "up" || key.name === "k") moveCursor(-1);
    if (key.name === "down" || key.name === "j") moveCursor(1);
    if (enterPressed) openDetail(lines[cursorIndex]);
  });

  if (picker.open) {
    return (
      <ProfilePicker
        profiles={picker.available}
        selected={picker.draft}
        cursor={picker.cursor}
        loading={picker.loading}
        error={picker.error}
        height={height}
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
      />
    );
  }

  // The detail line keeps its label even when it has no traffic in the current range.
  const detailEntry = detail ? lines.find((entry) => entry.key === detail.key) ?? null : null;
  const rows = data?.rows ?? [];
  const viewRows = detail
    ? rows.map((row) => detailEntry?.daily[row.date] ?? { date: row.date, ...emptyCounts() })
    : rows;
  const counts = detail ? detailEntry ?? emptyCounts() : data?.totals ?? emptyCounts();
  const previous = detail ? detailEntry?.previous ?? emptyCounts() : data?.previous ?? emptyCounts();
  const current = pick(counts, direction);
  const prior = pick(previous, direction);
  const total = current.messages + current.calls;
  const activeDays = viewRows.filter((row) => totalOf(row, direction) > 0).length;
  const activeLines = lines.filter((line) => totalOf(line, direction) > 0).length;
  const destinationLabel = detail
    ? [detail.profile && accounts.length > 1 ? detail.profile : "", detail.name ?? "", detail.number].filter(Boolean).join(" · ")
    : settings.filter ? `LINES MATCHING "${settings.filter}"` : "ALL LINES";
  const profileErrors = data?.errors ?? [];

  // Layout: fixed chrome, then the chart and line table share all remaining space.
  const innerWidth = Math.max(40, width - 2);
  const cards = width >= 120 && height >= 30;
  const wide = innerWidth >= 150 && height >= 24;
  const showAccountBar = accounts.length > 1;
  const showFilterBar = filterEdit.editing || !!settings.filter || settings.excluded.length > 0;
  const messages: Array<{ text: string; color: string }> = [];
  if (error) messages.push({ text: loaded ? `Refresh failed, showing last data: ${error}` : error, color: theme.red });
  for (const entry of profileErrors) messages.push({ text: `Account ${entry.profile ?? "active"} skipped: ${entry.message}`, color: theme.amber });
  if (detail && !detailEntry && data) messages.push({ text: `${detail.number} is not in the current view.`, color: theme.muted });
  const chromeHeight = 1 + 1 + (showAccountBar ? 1 : 0) + (showFilterBar ? 1 : 0) + (cards ? 4 : 1) + messages.length + 1;
  const bodyHeight = Math.max(8, height - chromeHeight);
  const chartWidth = wide ? Math.floor(innerWidth * 0.5) : innerWidth;
  const tableWidth = wide ? innerWidth - chartWidth - 1 : innerWidth;
  const chartHeight = wide ? bodyHeight : Math.max(8, Math.round(bodyHeight * (detail ? 0.62 : 0.5)));
  const tableHeight = wide ? bodyHeight : Math.max(5, bodyHeight - chartHeight);

  const updated = lastUpdated ? lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
  const status = loading
    ? { text: loaded ? "● SYNCING" : "● LOADING", color: theme.amber }
    : error
      ? { text: `● STALE · ${updated}`, color: theme.red }
      : { text: `● LIVE · ${updated}`, color: theme.cyan };
  const scopeLabel = focus ? `account ${focus}` : accounts.length > 1 ? `all ${accounts.length} accounts` : accountLabelFor(accounts);

  const directionDetail = direction === "both" ? `${formatNumber(pick(counts, "in").messages)} in · ${formatNumber(pick(counts, "out").messages)} out` : directionNames[direction].toLowerCase();
  const callDetail = direction === "both" ? `${formatNumber(pick(counts, "in").calls)} in · ${formatNumber(pick(counts, "out").calls)} out` : directionNames[direction].toLowerCase();
  const metricValues = [
    { title: "MESSAGES", label: "MSGS", value: formatNumber(current.messages), color: theme.cyan, detail: directionDetail, delta: percentChange(current.messages, prior.messages) },
    { title: "CALLS", label: "CALLS", value: formatNumber(current.calls), color: theme.violet, detail: callDetail, delta: percentChange(current.calls, prior.calls) },
    { title: "TOTAL EVENTS", label: "TOTAL", value: formatNumber(total), color: theme.ink, detail: `vs prev ${period}d`, delta: percentChange(total, prior.messages + prior.calls) },
    detail
      ? { title: "ACTIVE DAYS", label: "ACTIVE", value: `${activeDays}/${viewRows.length}`, color: theme.amber, detail: "with traffic", delta: undefined }
      : { title: "LINES", label: "LINES", value: `${formatNumber(activeLines)}/${formatNumber(lines.length)}`, color: theme.amber, detail: "with traffic", delta: undefined },
  ];

  const footerOptions = [
    "↑↓ select · Enter detail · Tab account · / filter · X exclude · D direction · 1-3 range · T chart · Z UTC/local · P accounts · E export · ? help · Q quit",
    "↑↓ select · Enter detail · Tab account · / filter · X exclude · D direction · T chart · ? help · Q quit",
    "↑↓ select · Enter detail · Tab account · / filter · X exclude · ? help · Q quit",
    "↑↓ · Enter · / filter · X exclude · ? help · Q quit",
  ];
  const footerRoom = innerWidth - (notice ? notice.text.length + 2 : 0);

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background} paddingX={1}>
      <box height={1} flexDirection="row" justifyContent="space-between">
        <text wrapMode="none">
          <span fg={theme.cyan}><strong>TWILIO</strong></span>
          <span fg={theme.muted}>-</span>
          <span fg={theme.ink}><strong>TUI</strong></span>
          <span fg={theme.muted}>   {clipText(scopeLabel, Math.max(8, innerWidth - 40))}</span>
        </text>
        <text fg={status.color} wrapMode="none">{status.text}</text>
      </box>

      {showAccountBar && (
        <box height={1} flexDirection="row" gap={1}>
          <text fg={theme.muted} wrapMode="none">ACCOUNT</text>
          <Tab label={`ALL ${accounts.length}`} active={!focus} onClick={() => setFocus(null)} />
          {accounts.map((account) => (
            <Tab key={account} label={account} active={focus === account} onClick={() => setFocus(account)} />
          ))}
          <text fg={theme.dim} wrapMode="none">  Tab / [ ] switch · A all · P choose</text>
        </box>
      )}

      <box height={1} flexDirection="row" justifyContent="space-between">
        <box flexDirection="row" gap={1}>
          {directions.map((mode) => (
            <Tab key={mode} label={directionNames[mode]} active={direction === mode} onClick={() => setDirection(mode)} accent={theme.violet} />
          ))}
          {detail && <Tab label="◂ BACK" active={false} onClick={() => setDetail(null)} />}
        </box>
        <box flexDirection="row" gap={1}>
          {periods.map((days) => <Tab key={days} label={`${days}D`} active={period === days} onClick={() => setPeriod(days)} />)}
          <text fg={theme.dim}>│</text>
          <Tab label={timeZone === "utc" ? "UTC" : "LOCAL"} active={false} onClick={() => setTimeZone((value) => value === "utc" ? "local" : "utc")} />
        </box>
      </box>

      {showFilterBar && (
        <box height={1} flexDirection="row" justifyContent="space-between" backgroundColor={filterEdit.editing ? theme.selection : undefined}>
          <text wrapMode="none">
            <span fg={theme.cyan}><strong>FILTER </strong></span>
            {filterEdit.editing ? (
              <>
                <span fg={filterEdit.fresh ? theme.background : theme.ink} bg={filterEdit.fresh ? theme.cyan : undefined}>{filterEdit.draft}</span>
                <span fg={theme.cyan}>▏</span>
                <span fg={theme.muted}>{filterEdit.fresh ? "   type to replace · → to edit" : ""}   Enter apply · Esc cancel · Ctrl+U clear · comma = any of · -word hides</span>
              </>
            ) : (
              <>
                <span fg={settings.filter ? theme.ink : theme.dim}>{settings.filter || "none"}</span>
                <span fg={theme.muted}>{data?.filteredOut ? `  (${formatNumber(data.filteredOut)} lines hidden)` : ""}</span>
              </>
            )}
          </text>
          {!filterEdit.editing && (
            <text wrapMode="none">
              <span fg={settings.excluded.length ? theme.red : theme.dim}>⊘ {settings.excluded.length} excluded numbers</span>
              <span fg={theme.muted}>{data?.excludedEvents ? ` · ${formatNumber(data.excludedEvents)} events left out` : ""} · X edit</span>
            </text>
          )}
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
        <text key={index} fg={message.color} wrapMode="none">{clipText(message.text, innerWidth)}</text>
      ))}

      <box flexDirection={wide ? "row" : "column"} gap={wide ? 1 : 0} height={bodyHeight}>
        <TrafficChart
          rows={viewRows}
          previous={previous}
          direction={direction}
          width={chartWidth}
          height={chartHeight}
          title={`${destinationLabel} · LAST ${period} DAYS (${timeZone.toUpperCase()})`}
          chartType={chartType}
          timeZone={timeZone}
        />
        <LineTable
          lines={lines}
          dates={rows.map((row) => row.date)}
          direction={direction}
          loaded={!!data}
          width={tableWidth}
          height={tableHeight}
          cursorIndex={cursorIndex}
          detailKey={detail?.key ?? null}
          showProfile={!focus && accounts.length > 1}
          filter={settings.filter}
          filteredOut={data?.filteredOut ?? 0}
          onRowClick={(index) => openDetail(lines[index])}
        />
      </box>

      <box height={1} flexDirection="row" justifyContent="space-between">
        <text fg={theme.muted} wrapMode="none">{clipText(footerOptions.find((option) => option.length <= footerRoom) ?? footerOptions.at(-1)!, footerRoom)}</text>
        {notice && <text fg={notice.error ? theme.red : theme.green} wrapMode="none">{notice.text}</text>}
      </box>

      {helpOpen && <HelpOverlay width={width} height={height} />}
    </box>
  );
}
