import { numberMatchKey, pick, spikeFlags, totalOf, type CliProfile, type Counts, type DirectionMode, type LineTraffic, type PeerTraffic, type TrafficRow } from "./data";
import {
  axisLabels,
  blockSparkline,
  brailleLineChart,
  compactNumber,
  niceMax,
  slotEdges,
  sparkline,
  spread,
  stackedColumns,
} from "./charts";
import { theme } from "./theme";

export type ChartType = "line" | "bars" | "spark" | "table";
export const chartTypes: ChartType[] = ["line", "bars", "spark", "table"];
const chartNames: Record<ChartType, string> = { line: "LINE", bars: "STACKED BARS", spark: "SPARKLINES", table: "DAILY TABLE" };
export const directionNames: Record<DirectionMode, string> = { both: "IN + OUT", in: "INCOMING", out: "OUTGOING" };

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function clipText(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  return width <= 1 ? value.slice(0, width) : `${value.slice(0, width - 1)}…`;
}

export function percentChange(current: number, previous: number): { text: string; color: string } {
  if (current === 0 && previous === 0) return { text: "—", color: theme.muted };
  if (previous === 0) return { text: "new", color: theme.green };
  const change = (current - previous) / previous * 100;
  const rounded = Math.abs(change) >= 10 ? Math.round(change) : Math.round(change * 10) / 10;
  if (rounded === 0) return { text: "±0%", color: theme.muted };
  return rounded > 0
    ? { text: `▲${rounded}%`, color: theme.green }
    : { text: `▼${Math.abs(rounded)}%`, color: theme.amber };
}

export function Panel({ title, width, height, children, active = false }: {
  title: string;
  width?: number;
  height?: number;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <box
      width={width}
      height={height}
      flexGrow={width === undefined ? 1 : 0}
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={active ? theme.borderActive : theme.border}
      title={` ${title} `}
      titleColor={theme.ink}
      backgroundColor={theme.panel}
      paddingX={1}
      flexDirection="column"
    >
      {children}
    </box>
  );
}

export function Tab({ label, active, onClick, accent = theme.cyan }: { label: string; active: boolean; onClick: () => void; accent?: string }) {
  return (
    <box onMouseDown={onClick}>
      <text fg={active ? theme.background : theme.muted} bg={active ? accent : undefined} wrapMode="none">{` ${label} `}</text>
    </box>
  );
}

export function MetricCard({ title, value, color, detail, delta }: {
  title: string;
  value: string;
  color: string;
  detail: string;
  delta?: { text: string; color: string };
}) {
  return (
    <box flexGrow={1} flexBasis={0} minWidth={16} height={4} border borderStyle="rounded" borderColor={theme.border} backgroundColor={theme.panel} paddingX={1} flexDirection="column">
      <text fg={theme.muted} wrapMode="none">{title}</text>
      <text wrapMode="none">
        <span fg={color}><strong>{value}</strong></span>
        {delta && <span fg={delta.color}>  {delta.text}</span>}
        <span fg={theme.muted}>  {detail}</span>
      </text>
    </box>
  );
}

export function MetricStrip({ values }: { values: Array<{ label: string; value: string; color: string; delta?: { text: string; color: string } }> }) {
  return (
    <box height={1} flexDirection="row" gap={3}>
      {values.map((item) => (
        <text key={item.label} wrapMode="none">
          <span fg={theme.muted}>{item.label} </span>
          <span fg={item.color}><strong>{item.value}</strong></span>
          {item.delta && <span fg={item.delta.color}> {item.delta.text}</span>}
        </text>
      ))}
    </box>
  );
}

function shortDate(date: string): string {
  return date.slice(5);
}

function xLabels(rows: TrafficRow[], width: number, positionOf: (index: number) => number): string {
  if (!rows.length) return "";
  const count = Math.max(2, Math.floor(width / 9));
  const step = Math.max(1, Math.ceil((rows.length - 1) / (count - 1)));
  const indexes = new Set<number>();
  for (let index = 0; index < rows.length; index += step) indexes.add(index);
  indexes.add(rows.length - 1);
  // Always keep the last date; drop the label just before it if they would collide.
  const ordered = [...indexes].sort((a, b) => a - b);
  const labels = ordered.map((index) => ({ at: positionOf(index), text: shortDate(rows[index]!.date) }));
  const last = labels.pop()!;
  return axisLabels([...labels.filter((label) => label.at + 6 < last.at - 3), last], width);
}

const yAxisWidth = 7;

function yAxis(row: number, rows: number, max: number): string {
  const ticks = new Map<number, number>([[0, max], [rows - 1, 0]]);
  if (rows >= 5) ticks.set(Math.round((rows - 1) / 2), max / 2);
  const value = ticks.get(row);
  return value === undefined ? `${" ".repeat(yAxisWidth - 2)} │` : `${compactNumber(value).padStart(yAxisWidth - 2)} ┤`;
}

export function TrafficChart({ rows, previous, direction, width, height, title, chartType, timeZone }: {
  rows: TrafficRow[];
  previous: Counts;
  direction: DirectionMode;
  width: number;
  height: number;
  title: string;
  chartType: ChartType;
  timeZone: "utc" | "local";
}) {
  const contentWidth = Math.max(10, width - 4);
  const contentHeight = Math.max(3, height - 2);
  const plotWidth = Math.max(4, contentWidth - yAxisWidth);
  const plotRows = Math.max(2, contentHeight - 2);
  const series = rows.map((row) => pick(row, direction));
  const messages = series.map((entry) => entry.messages);
  const calls = series.map((entry) => entry.calls);
  const messageTotal = messages.reduce((sum, value) => sum + value, 0);
  const callTotal = calls.reduce((sum, value) => sum + value, 0);
  const prior = pick(previous, direction);
  const totals = series.map((entry) => entry.messages + entry.calls);
  const peakIndex = totals.reduce((best, value, index) => value > (totals[best] ?? -1) ? index : best, 0);
  const average = rows.length ? (messageTotal + callTotal) / rows.length : 0;
  const pad = " ".repeat(yAxisWidth);
  const spikes = spikeFlags(totals);

  const legend = (
    <box height={1} flexDirection="row" justifyContent="space-between">
      <text wrapMode="none">
        <span fg={theme.cyan}>━ MESSAGES </span><span fg={theme.ink}>{formatNumber(messageTotal)}</span>
        <span fg={percentChange(messageTotal, prior.messages).color}> {percentChange(messageTotal, prior.messages).text}</span>
        <span fg={theme.violet}>   ━ CALLS </span><span fg={theme.ink}>{formatNumber(callTotal)}</span>
        <span fg={percentChange(callTotal, prior.calls).color}> {percentChange(callTotal, prior.calls).text}</span>
        {contentWidth > 90 && (totals[peakIndex] ?? 0) > 0 && (
          <span fg={theme.muted}>   peak {formatNumber(totals[peakIndex]!)} on {shortDate(rows[peakIndex]!.date)} · avg {compactNumber(average)}/day</span>
        )}
      </text>
      <text fg={theme.dim} wrapMode="none">{directionNames[direction]} · {chartNames[chartType]}</text>
    </box>
  );

  let body: React.ReactNode;
  if (chartType === "line") {
    const max = niceMax(Math.max(1, ...messages, ...calls));
    const lines = brailleLineChart(
      [{ values: calls, color: theme.violet }, { values: messages, color: theme.cyan }],
      plotWidth,
      plotRows,
      max,
      { overlapColor: theme.overlap, emptyColor: theme.grid },
    );
    const points = Math.min(rows.length, plotWidth * 2);
    body = (
      <>
        {lines.map((line, index) => (
          <text key={index}><span fg={theme.dim}>{yAxis(index, plotRows, max)}</span>{line.map((segment, segmentIndex) => (
            <span key={segmentIndex} fg={segment.fg}>{segment.text}</span>
          ))}</text>
        ))}
        <text fg={theme.muted}>{pad}{xLabels(rows, plotWidth, (index) => {
          const point = Math.round(index * (points - 1) / Math.max(1, rows.length - 1));
          return Math.round(point * (plotWidth * 2 - 1) / Math.max(1, points - 1) / 2);
        })}</text>
      </>
    );
  } else if (chartType === "bars") {
    const chart = stackedColumns(messages, calls, plotWidth, plotRows, { bottomColor: theme.cyan, topColor: theme.violet, emptyColor: theme.grid });
    body = (
      <>
        {chart.lines.map((line, index) => (
          <text key={index}><span fg={theme.dim}>{yAxis(index, plotRows, chart.max)}</span>{line.map((segment, segmentIndex) => (
            <span key={segmentIndex} fg={segment.fg} bg={segment.bg}>{segment.text}</span>
          ))}</text>
        ))}
        <text fg={theme.muted}>{pad}{xLabels(rows, plotWidth, (index) => {
          const bins = chart.edges.length - 1;
          const bin = Math.min(bins - 1, Math.floor(index * bins / rows.length));
          return (chart.edges[bin]! + chart.edges[bin + 1]! - 1) / 2;
        })}</text>
      </>
    );
  } else if (chartType === "spark") {
    const half = Math.max(1, Math.floor((plotRows - 1) / 2));
    const sparkEdges = slotEdges(Math.min(rows.length, plotWidth), plotWidth);
    const axis = (index: number, max: number) => index === 0 ? `${compactNumber(max).padStart(yAxisWidth - 2)} ┤` : `${" ".repeat(yAxisWidth - 2)} │`;
    body = (
      <>
        {blockSparkline(spread(messages, plotWidth), plotWidth, half).map((line, index) => (
          <text key={`m${index}`}><span fg={theme.dim}>{axis(index, Math.max(0, ...messages))}</span><span fg={theme.cyan}>{line}</span></text>
        ))}
        <text fg={theme.dim}>{pad}{"─".repeat(plotWidth)}</text>
        {blockSparkline(spread(calls, plotWidth), plotWidth, Math.max(1, plotRows - half - 1)).map((line, index) => (
          <text key={`c${index}`}><span fg={theme.dim}>{axis(index, Math.max(0, ...calls))}</span><span fg={theme.violet}>{line}</span></text>
        ))}
        <text fg={theme.muted}>{pad}{xLabels(rows, plotWidth, (index) => {
          const bin = Math.min(sparkEdges.length - 2, Math.floor(index * (sparkEdges.length - 1) / rows.length));
          return (sparkEdges[bin]! + sparkEdges[bin + 1]! - 1) / 2;
        })}</text>
      </>
    );
  } else {
    const countWidth = Math.max(6, Math.min(9, Math.floor((contentWidth - 16) / 7)));
    const columns: Array<[string, (row: TrafficRow) => number]> = direction === "both"
      ? [["MSG IN", (row) => row.msgIn], ["MSG OUT", (row) => row.msgOut], ["CALL IN", (row) => row.callIn], ["CALL OUT", (row) => row.callOut]]
      : [["MESSAGES", (row) => pick(row, direction).messages], ["CALLS", (row) => pick(row, direction).calls]];
    const barWidth = Math.max(0, contentWidth - 13 - (countWidth + 1) * (columns.length + 1) - 2);
    const max = Math.max(1, ...totals);
    const ordered = rows.map((row, index) => ({ row, index })).reverse().slice(0, plotRows);
    body = (
      <>
        <text fg={theme.muted} wrapMode="none">{`DATE ${timeZone.toUpperCase()}`.padEnd(11)}  {columns.map(([label]) => label.padStart(countWidth)).join(" ")} {"TOTAL".padStart(countWidth)}</text>
        {ordered.map(({ row, index }) => {
          const value = series[index]!;
          return (
            <text key={row.date} wrapMode="none">
              <span fg={spikes[index] ? theme.amber : theme.ink}>{row.date.padEnd(10)}{spikes[index] ? " ⚑" : "  "}</span>
              <span fg={theme.ink}> {columns.map(([, get]) => formatNumber(get(row)).padStart(countWidth)).join(" ")} {formatNumber(totals[index]!).padStart(countWidth)}  </span>
              <span fg={theme.cyan}>{"█".repeat(Math.round(value.messages / max * barWidth))}</span>
              <span fg={theme.violet}>{"█".repeat(Math.round(value.calls / max * barWidth))}</span>
            </text>
          );
        })}
      </>
    );
  }

  return (
    <Panel title={clipText(title, Math.max(10, width - 6))} width={width} height={height}>
      {legend}
      {body}
    </Panel>
  );
}

export function LineTable({ lines, dates, direction, loaded, width, height, cursorIndex, detailKey, showProfile, filter, filteredOut, onRowClick }: {
  lines: LineTraffic[];
  dates: string[];
  direction: DirectionMode;
  loaded: boolean;
  width: number;
  height: number;
  cursorIndex: number;
  detailKey: string | null;
  showProfile: boolean;
  filter: string;
  filteredOut: number;
  onRowClick: (index: number) => void;
}) {
  const contentWidth = Math.max(20, width - 4);
  const visibleRows = Math.max(1, height - 4);
  const firstIndex = Math.max(0, Math.min(cursorIndex - Math.floor(visibleRows / 2), lines.length - visibleRows));
  const entries = lines.slice(firstIndex, firstIndex + visibleRows);

  const longestName = Math.max(4, ...lines.map((entry) => entry.name?.length ?? (entry.owned ? 1 : 16)));
  const numberWidth = Math.min(Math.max(12, ...lines.map((entry) => entry.number.length)), 18);
  const deltaWidth = contentWidth >= 60 ? 6 : 0;
  const profileWidth = showProfile
    ? Math.max(6, Math.min(14, Math.max(7, ...lines.map((entry) => (entry.profile ?? "active").length))))
    : 0;
  const layout = (split: boolean) => {
    const columnWidth = split ? 8 : contentWidth >= 70 ? 7 : 6;
    const metricCount = split ? 4 : 2;
    const fixed = 2 + (showProfile ? profileWidth + 2 : 0) + (columnWidth + 1) * (metricCount + 1) + (deltaWidth ? deltaWidth + 1 : 0) + 3;
    return { split, columnWidth, free: contentWidth - fixed - numberWidth - 1 };
  };
  // Prefer in/out columns when names still get a readable width.
  const splitLayout = layout(true);
  const { split, columnWidth, free } = direction === "both" && splitLayout.free >= Math.min(longestName, 22) + 1 ? splitLayout : layout(false);
  const metrics: Array<[string, (line: Counts) => number, string]> = split
    ? [
      ["MSG IN", (line) => line.msgIn, theme.cyan],
      ["MSG OUT", (line) => line.msgOut, theme.cyan],
      ["CALL IN", (line) => line.callIn, theme.violet],
      ["CALL OUT", (line) => line.callOut, theme.violet],
    ]
    : [
      ["MSGS", (line) => pick(line, direction).messages, theme.cyan],
      ["CALLS", (line) => pick(line, direction).calls, theme.violet],
    ];
  // Names get priority (up to 28 cells); the trend sparkline uses the rest when it can get at least 8.
  const nameWidth = Math.max(0, Math.min(longestName, free >= 44 ? 32 : free));
  const showName = nameWidth >= 8;
  const trendWidth = Math.max(0, free - (showName ? nameWidth + 1 : 0) - 2);
  const showTrend = trendWidth >= 8;

  const header = [
    "  ",
    showProfile ? `${"ACCOUNT".padEnd(profileWidth)}  ` : "",
    showName ? `${"NAME".padEnd(nameWidth)} ` : "",
    "NUMBER".padEnd(numberWidth),
    " ",
    metrics.map(([label]) => label.padStart(columnWidth)).join(" "),
    " ",
    "TOTAL".padStart(columnWidth),
    deltaWidth ? ` ${"Δ".padStart(deltaWidth)}` : "",
    "   ",
    showTrend ? `  ${"TREND".padEnd(trendWidth)}` : "",
  ].join("");

  const title = filter
    ? `LINES · ${formatNumber(lines.length)} matching "${filter}"`
    : `LINES · ${formatNumber(lines.length)}`;

  return (
    <Panel title={title} width={width} height={height} active={!!filter}>
      <text fg={theme.muted} wrapMode="none">{clipText(header, contentWidth)}</text>
      {entries.length ? entries.map((entry, index) => {
        const actualIndex = firstIndex + index;
        const selected = actualIndex === cursorIndex;
        const open = entry.key === detailKey;
        const total = totalOf(entry, direction);
        const change = percentChange(total, totalOf(entry.previous, direction));
        const values = dates.map((date) => {
          const day = entry.daily[date];
          return day ? totalOf(day, direction) : 0;
        });
        const spikeCount = spikeFlags(values).filter(Boolean).length;
        const quiet = total === 0;
        return (
          <box key={entry.key} height={1} backgroundColor={selected ? theme.selection : undefined} onMouseDown={() => onRowClick(actualIndex)}>
            <text wrapMode="none">
              <span fg={selected ? theme.cyan : theme.dim}>{open ? "● " : selected ? "› " : "  "}</span>
              {showProfile && <span fg={theme.muted}>{clipText(entry.profile ?? "active", profileWidth).padEnd(profileWidth)}  </span>}
              {showName && <span fg={selected ? theme.cyan : entry.name ? quiet ? theme.muted : theme.ink : theme.dim}>{clipText(entry.name ?? (entry.owned ? "—" : entry.number === "Unknown" ? "(no number)" : "(not on account)"), nameWidth).padEnd(nameWidth)} </span>}
              <span fg={selected ? theme.cyan : showName || quiet ? theme.muted : theme.ink}>{clipText(entry.number, numberWidth).padEnd(numberWidth)} </span>
              {metrics.map(([label, get, color]) => (
                <span key={label} fg={get(entry) ? color : theme.dim}>{formatNumber(get(entry)).padStart(columnWidth)} </span>
              ))}
              <span fg={quiet ? theme.dim : theme.ink}>{formatNumber(total).padStart(columnWidth)}</span>
              {deltaWidth > 0 && <span fg={change.color}> {change.text.padStart(deltaWidth)}</span>}
              <span fg={theme.amber}>{spikeCount ? ` ⚑${spikeCount > 9 ? "+" : spikeCount}` : "   "}</span>
              {showTrend && <span fg={selected ? theme.cyan : theme.muted}>  {quiet ? "" : sparkline(values, trendWidth)}</span>}
            </text>
          </box>
        );
      }) : (
        <text fg={theme.muted}>{!loaded ? "Waiting for account data…" : filter ? `No lines in this view match "${filter}". Press / to change the filter, or Tab / A to switch account.` : "No phone numbers or traffic found for this account."}</text>
      )}
      <box flexGrow={1} />
      <text fg={theme.dim} wrapMode="none">
        {clipText([
          lines.length > entries.length ? `${firstIndex + 1}–${firstIndex + entries.length} of ${formatNumber(lines.length)}` : "",
          filteredOut > 0 ? `${formatNumber(filteredOut)} hidden by filter` : "",
          "/ filter",
          "↑↓ select · Enter detail",
          lines.length > entries.length ? "" : "⚑ unusual days",
        ].filter(Boolean).join(" · "), contentWidth)}
      </text>
    </Panel>
  );
}

function Screen({ title, subtitle, footer, children }: { title: string; subtitle: string; footer: string; children: React.ReactNode }) {
  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background} padding={1}>
      <text wrapMode="none"><span fg={theme.cyan}><strong>TWILIO</strong></span><span fg={theme.muted}> / </span><span fg={theme.ink}><strong>{title}</strong></span></text>
      <text fg={theme.muted}>{subtitle}</text>
      {children}
      <text fg={theme.muted} wrapMode="none">{footer}</text>
    </box>
  );
}

function scrollWindow(cursor: number, count: number, visible: number): number {
  return Math.max(0, Math.min(cursor - Math.floor(visible / 2), count - visible));
}

export function ProfilePicker({ profiles, selected, cursor, loading, error, height }: {
  profiles: CliProfile[];
  selected: string[];
  cursor: number;
  loading: boolean;
  error: string | null;
  height: number;
}) {
  const visibleRows = Math.max(3, height - 10);
  const firstIndex = scrollWindow(cursor, profiles.length, visibleRows);
  const visibleProfiles = profiles.slice(firstIndex, firstIndex + visibleRows);

  return (
    <Screen
      title="CHOOSE ACCOUNTS"
      subtitle="Choose which saved Twilio CLI profiles (accounts) to load. The account bar then lets you view them one at a time or all together."
      footer="↑/↓ move   Space/Enter toggle   A select all   C use active CLI profile   R reload   D done   Esc cancel"
    >
      <Panel title={`ACCOUNTS · ${selected.length || "active CLI profile"} selected`}>
        {loading && <text fg={theme.amber}>Loading profiles from Twilio CLI…</text>}
        {error && <text fg={theme.red}>{error}</text>}
        {!loading && !error && profiles.length === 0 && (
          <text fg={theme.muted}>No saved profiles found. Create one with `twilio login`, then press R to reload.</text>
        )}
        {!loading && visibleProfiles.map((profile, index) => {
          const actualIndex = firstIndex + index;
          const checked = selected.includes(profile.id);
          const current = actualIndex === cursor;
          return (
            <box key={profile.id} height={1} backgroundColor={current ? theme.selection : undefined}>
              <text wrapMode="none">
                <span fg={current ? theme.cyan : theme.dim}>{current ? "› " : "  "}</span>
                <span fg={checked ? theme.cyan : theme.muted}>{checked ? "[✓] " : "[ ] "}</span>
                <span fg={current ? theme.cyan : theme.ink}>{profile.id.padEnd(32)}</span>
                <span fg={theme.muted}>{profile.accountSid ?? ""}</span>
                {profile.active && <span fg={theme.amber}>  active</span>}
              </text>
            </box>
          );
        })}
        <box flexGrow={1} />
        {profiles.length > visibleProfiles.length && (
          <text fg={theme.dim}>Showing {firstIndex + 1}–{firstIndex + visibleProfiles.length} of {profiles.length}</text>
        )}
      </Panel>
    </Screen>
  );
}

export function ExclusionsScreen({ peers, excluded, cursor, input, adding, height, width }: {
  peers: PeerTraffic[];
  excluded: string[];
  cursor: number;
  input: string;
  adding: boolean;
  height: number;
  width: number;
}) {
  const rows = exclusionRows(peers, excluded);
  const visibleRows = Math.max(3, height - 12);
  const firstIndex = scrollWindow(cursor, rows.length, visibleRows);
  const visible = rows.slice(firstIndex, firstIndex + visibleRows);
  const contentWidth = Math.max(40, width - 6);
  const numberWidth = Math.min(28, Math.max(14, ...rows.map((row) => row.number.length)));
  const columnWidth = 8;

  return (
    <Screen
      title="EXCLUDE NUMBERS"
      subtitle="Traffic to or from excluded numbers (for example your test phones) is left out of every total, chart and line. Your own lines always stay listed."
      footer="↑/↓ move   Space/Enter toggle   N type a number   Backspace un-exclude   Esc/X done"
    >
      <Panel title={`OUTSIDE NUMBERS · ${excluded.length} excluded · sorted by traffic in range`}>
        {adding ? (
          <text wrapMode="none"><span fg={theme.cyan}>Add number: </span><span fg={theme.ink}>{input}</span><span fg={theme.cyan}>▏</span><span fg={theme.muted}>   Enter add · Esc cancel · any format, e.g. 555 010 0001</span></text>
        ) : (
          <text fg={theme.muted} wrapMode="none">{clipText(`    ${"NUMBER".padEnd(numberWidth)} ${"MSG IN".padStart(columnWidth)} ${"MSG OUT".padStart(columnWidth)} ${"CALL IN".padStart(columnWidth)} ${"CALL OUT".padStart(columnWidth)}`, contentWidth)}</text>
        )}
        {visible.length ? visible.map((row, index) => {
          const actualIndex = firstIndex + index;
          const current = actualIndex === cursor && !adding;
          const checked = row.excluded;
          const count = (value: number | undefined) => (value === undefined ? "" : formatNumber(value)).padStart(columnWidth);
          return (
            <box key={row.number} height={1} backgroundColor={current ? theme.selection : undefined}>
              <text wrapMode="none">
                <span fg={current ? theme.cyan : theme.dim}>{current ? "› " : "  "}</span>
                <span fg={checked ? theme.red : theme.muted}>{checked ? "⊘ " : "  "}</span>
                <span fg={checked ? theme.red : current ? theme.cyan : theme.ink}>{clipText(row.number, numberWidth).padEnd(numberWidth)} </span>
                <span fg={theme.cyan}>{count(row.counts?.msgIn)} {count(row.counts?.msgOut)} </span>
                <span fg={theme.violet}>{count(row.counts?.callIn)} {count(row.counts?.callOut)}</span>
                {!row.counts && <span fg={theme.dim}>   no traffic in range</span>}
              </text>
            </box>
          );
        }) : (
          <text fg={theme.muted}>No outside numbers in this range. Press N to add one.</text>
        )}
        <box flexGrow={1} />
        {rows.length > visible.length && <text fg={theme.dim}>Showing {firstIndex + 1}–{firstIndex + visible.length} of {rows.length}</text>}
      </Panel>
    </Screen>
  );
}

/** Excluded numbers first (so they are easy to undo), then every other outside number by traffic. */
export function exclusionRows(peers: PeerTraffic[], excluded: string[]): Array<{ number: string; counts?: Counts; excluded: boolean }> {
  const byKey = new Map(peers.map((peer) => [numberMatchKey(peer.number), peer]));
  const excludedKeys = new Set(excluded.map(numberMatchKey));
  return [
    ...excluded.map((number) => ({ number, counts: byKey.get(numberMatchKey(number)), excluded: true })),
    ...peers.filter((peer) => !excludedKeys.has(numberMatchKey(peer.number))).map((peer) => ({ number: peer.number, counts: peer, excluded: false })),
  ];
}

export const helpSections: Array<{ title: string; rows: Array<[string, string]> }> = [
  {
    title: "VIEW",
    rows: [
      ["1 2 3  ← →", "Last 7, 30 or 90 days"],
      ["D", "Direction: in + out, incoming only, outgoing only"],
      ["T", "Chart: line, stacked bars, sparklines, daily table"],
      ["Z", "Day boundaries in UTC or local time"],
    ],
  },
  {
    title: "ACCOUNTS",
    rows: [
      ["Tab  ⇧Tab  ] [", "Show one account at a time (next / previous)"],
      ["A", "Show all loaded accounts combined"],
      ["P", "Choose which accounts (CLI profiles) are loaded"],
    ],
  },
  {
    title: "LINES",
    rows: [
      ["↑ ↓  j k", "Select a line (steps lines while in detail)"],
      ["Enter / click", "Open line detail"],
      ["Backspace / Esc", "Leave line detail (Esc on the main view quits)"],
      ["/", "Filter by name or number: a, b = either · -word hides"],
      ["Ctrl+U", "Clear the filter"],
      ["X", "Exclude outside numbers (test phones) from all counts"],
    ],
  },
  {
    title: "OTHER",
    rows: [
      ["E", "Export CSV (twilio-tui-<timestamp>.csv)"],
      ["R / ⇧R", "Refresh now / clear cache and reload everything"],
      ["?", "Toggle this help"],
      ["Q", "Quit"],
    ],
  },
];

export const helpNotes = [
  "Tabs, the account bar and line rows are clickable.",
  "Δ compares with the previous period of the same length.",
  "⚑ marks days with at least 3× the daily average.",
  "Accounts, the account in view, the filter and exclusions are saved.",
];

export function HelpOverlay({ width, height }: { width: number; height: number }) {
  const lineCount = helpSections.reduce((sum, section) => sum + section.rows.length + 1, 0) + helpNotes.length + 1;
  const boxWidth = Math.min(width - 4, 88);
  const boxHeight = Math.min(height - 2, lineCount + 4);
  return (
    <box
      position="absolute"
      width={boxWidth}
      height={boxHeight}
      top={Math.max(1, Math.floor((height - boxHeight) / 2))}
      left={Math.max(2, Math.floor((width - boxWidth) / 2))}
      border
      borderStyle="rounded"
      borderColor={theme.borderActive}
      title=" KEYBOARD · ? or Esc to close "
      titleColor={theme.cyan}
      backgroundColor={theme.background}
      paddingX={2}
      paddingY={1}
      flexDirection="column"
      zIndex={10}
    >
      {helpSections.map((section) => (
        <box key={section.title} flexDirection="column">
          <text fg={theme.muted} wrapMode="none"><strong>{section.title}</strong></text>
          {section.rows.map(([keys, label]) => (
            <text key={keys} wrapMode="none"><span fg={theme.cyan}>{`  ${keys}`.padEnd(20)}</span><span fg={theme.ink}>{label}</span></text>
          ))}
        </box>
      ))}
      <box flexGrow={1} minHeight={1} />
      {helpNotes.map((note) => <text key={note} fg={theme.muted} wrapMode="none">{note}</text>)}
    </box>
  );
}
