import { plottable, cumulativeRows, groupTrafficRows, numberMatchKey, pick, spikeFlags, totalOf, type ChartInterval, type CliProfile, type Counts, type DirectionMode, type LineTraffic, type PeerTraffic, type TrafficRow, type UniqueTraffic } from "./data";
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
import type { MouseEvent } from "@opentui/core";

export function mouseScrollStep(event: MouseEvent): number {
  const direction = event.scroll?.direction;
  return direction === "up" ? -1 : direction === "down" ? 1 : 0;
}

export type ChartType = "line" | "bars" | "spark" | "table";
export const chartTypes: ChartType[] = ["line", "bars", "spark", "table"];
const chartNames: Record<ChartType, string> = { line: "LINE", bars: "STACKED BARS", spark: "SPARKLINES", table: "TABLE" };
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

export function Panel({ title, width, height, children, active = false, onMouseScroll }: {
  title: string;
  width?: number;
  height?: number;
  active?: boolean;
  children: React.ReactNode;
  onMouseScroll?: (event: MouseEvent) => void;
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
      onMouseScroll={onMouseScroll}
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

export function TrafficChart({ rows: dailyRows, previous, direction: requestedDirection, width, height, title, chartType, timeZone, cumulative = false, interval = "daily", unique, comparisonComplete = true, onToggleMode, onToggleInterval, onSelectRange, onNextChart, onDownload, onChooseDates, onShowActivity }: {
  rows: TrafficRow[];
  previous: Counts;
  direction: DirectionMode;
  width: number;
  height: number;
  title: string;
  chartType: ChartType;
  timeZone: "utc" | "local";
  cumulative?: boolean;
  interval?: ChartInterval;
  unique?: UniqueTraffic;
  comparisonComplete?: boolean;
  onToggleMode?: () => void;
  onToggleInterval?: () => void;
  onSelectRange?: (from: string, through: string) => void;
  onNextChart?: () => void;
  onDownload?: () => void;
  onChooseDates?: () => void;
  onShowActivity?: () => void;
}) {
  const groupedRows = groupTrafficRows(dailyRows, interval);
  const rows = unique?.rows ?? (cumulative ? cumulativeRows(groupedRows) : groupedRows);
  const direction = unique ? "in" : requestedDirection;
  // A cumulative point represents the total through the end of its day or week.
  const axisRows = cumulative ? rows.map((row) => ({ ...row, date: row.endDate ?? row.date })) : rows;
  const contentWidth = Math.max(10, width - 4);
  const contentHeight = Math.max(3, height - 2);
  const plotWidth = Math.max(4, contentWidth - yAxisWidth);
  const plotRows = Math.max(2, contentHeight - 2);
  const series = rows.map((row) => pick(row, direction));
  const inProgress = rows.some((row) => row.inProgress);
  const gaps = rows.some((row) => !plottable(row));
  const incomplete = rows.some((row) => row.coverage && row.coverage !== "complete");
  const messages = series.map((entry, index) => !plottable(rows[index]!) ? NaN : entry.messages);
  const calls = series.map((entry, index) => !plottable(rows[index]!) ? NaN : entry.calls);
  const eventSeries = messages.map((value, index) => Number.isFinite(value) ? totalOf(rows[index]!, direction) : NaN);
  const messageTotal = unique?.totals.msgIn ?? dailyRows.reduce((sum, row) => sum + pick(row, direction).messages, 0);
  const callTotal = unique?.totals.callIn ?? dailyRows.reduce((sum, row) => sum + pick(row, direction).calls, 0);
  const combinedTotal = unique?.totals.contacts ?? messageTotal + callTotal;
  const prior = pick(previous, direction);
  const totals = rows.map((row) => totalOf(row, direction));
  const peakIndex = totals.reduce((best, value, index) => value > (totals[best] ?? -1) ? index : best, 0);
  const average = rows.length ? combinedTotal / rows.length : 0;
  const pad = " ".repeat(yAxisWidth);
  const spikes = cumulative || incomplete ? totals.map(() => false) : spikeFlags(totals);
  const delta = (current: number, previous: number) => comparisonComplete && !incomplete ? percentChange(current, previous) : { text: "", color: theme.muted };
  const showComparison = !unique && !cumulative && (!onToggleInterval || contentWidth > 100);
  const modeLabel = cumulative ? "CUMULATIVE" : interval.toUpperCase();
  const selectRows = (from: number, through: number) => {
    const first = rows[from];
    const last = rows[through];
    if (first && last) onSelectRange?.(cumulative ? dailyRows[0]?.date ?? first.date : first.date, last.endDate ?? last.date);
  };
  const selectPlot = (event: MouseEvent, bins: number, edges?: number[]) => {
    if (event.button !== 0 || !bins) return;
    const x = event.x - (event.currentTarget?.x ?? event.target?.x ?? 0) - yAxisWidth;
    if (x < 0 || x >= plotWidth) return;
    const bin = edges ? Math.max(0, edges.findIndex((edge) => edge > x) - 1)
      : Math.round(x / Math.max(1, plotWidth - 1) * (bins - 1));
    selectRows(Math.floor(bin * rows.length / bins), Math.floor((bin + 1) * rows.length / bins) - 1);
  };

  const legend = (
    <box height={1} flexDirection="row" justifyContent="space-between">
      <text wrapMode="none">
        <span fg={theme.cyan}>{unique ? requestedDirection === "in" ? "━ TEXTERS " : "━ TEXT NOS. " : "━ TEXTS "}</span><span fg={theme.ink}>{incomplete ? "≥" : ""}{formatNumber(messageTotal)}</span>
        {showComparison && <span fg={delta(messageTotal, prior.messages).color}> {delta(messageTotal, prior.messages).text}</span>}
        <span fg={theme.violet}>{unique ? requestedDirection === "in" ? "   ━ CALLERS " : "   ━ CALL NOS. " : "   ━ CALLS "}</span><span fg={theme.ink}>{incomplete ? "≥" : ""}{formatNumber(callTotal)}</span>
        {showComparison && <span fg={delta(callTotal, prior.calls).color}> {delta(callTotal, prior.calls).text}</span>}
        {(cumulative || unique) && <span fg={theme.ink}>   ━ {unique ? "CONTACTS" : "EVENTS"} {incomplete ? "≥" : ""}{formatNumber(combinedTotal)}</span>}
        {!unique && !cumulative && !incomplete && contentWidth > 140 && (totals[peakIndex] ?? 0) > 0 && (
          <span fg={theme.muted}>   peak {formatNumber(totals[peakIndex]!)} on {shortDate(rows[peakIndex]!.date)} · avg {compactNumber(average)}/{interval === "weekly" ? "week" : "day"}</span>
        )}
      </text>
      <box height={1} flexDirection="row" flexShrink={0}>
        {inProgress && <text fg={theme.amber}>SO FAR · </text>}
        {gaps && <text fg={theme.dim}>{cumulative || onToggleInterval ? "░ " : "░ UNKNOWN · "}</text>}
        {onToggleMode ? <Tab label={`C ${modeLabel}`} active={false} onClick={onToggleMode} />
          : <text fg={theme.dim}>{modeLabel}</text>}
        {onToggleInterval ? <Tab label={`I ${interval.toUpperCase()}`} active={false} onClick={onToggleInterval} />
          : interval === "weekly" && cumulative && <text fg={theme.dim}> · WEEKLY</text>}
        {onNextChart && contentWidth > 100 ? <Tab label={`T ${chartNames[chartType]}`} active={false} onClick={onNextChart} />
          : (!onToggleInterval || contentWidth > 100) && <text fg={theme.dim} wrapMode="none"> · {chartNames[chartType]}</text>}
      </box>
    </box>
  );

  let body: React.ReactNode;
  if (chartType === "line") {
    const plotted: Array<{ values: number[]; color: string }> = [{ values: calls, color: theme.violet }, { values: messages, color: theme.cyan }];
    if (cumulative || unique) plotted.push({ values: eventSeries, color: theme.ink });
    const max = niceMax(Math.max(1, ...plotted.flatMap((series) => series.values.filter(Number.isFinite))));
    const lines = brailleLineChart(
      plotted,
      plotWidth,
      plotRows,
      max,
      { overlapColor: theme.overlap, emptyColor: theme.grid, cumulative },
    );
    const points = Math.min(rows.length, plotWidth * 2);
    body = (
      <>
        {lines.map((line, index) => (
          <text key={index} onMouseDown={(event) => selectPlot(event, Math.min(rows.length, plotWidth * 2))}><span fg={theme.dim}>{yAxis(index, plotRows, max)}</span>{line.map((segment, segmentIndex) => (
            <span key={segmentIndex} fg={segment.fg}>{segment.text}</span>
          ))}</text>
        ))}
        <text fg={theme.muted}>{pad}{xLabels(axisRows, plotWidth, (index) => {
          const point = Math.round(index * (points - 1) / Math.max(1, rows.length - 1));
          return Math.round(point * (plotWidth * 2 - 1) / Math.max(1, points - 1) / 2);
        })}</text>
      </>
    );
  } else if (chartType === "bars") {
    // Unique callers and texters overlap: stacking them would overstate reach.
    const chart = stackedColumns(unique ? eventSeries : messages, unique ? eventSeries.map((value) => Number.isFinite(value) ? 0 : NaN) : calls, plotWidth, plotRows,
      { bottomColor: unique ? theme.ink : theme.cyan, topColor: theme.violet, emptyColor: theme.grid, cumulative: cumulative || !!unique });
    body = (
      <>
        {chart.lines.map((line, index) => (
          <text key={index} onMouseDown={(event) => selectPlot(event, chart.edges.length - 1, chart.edges)}><span fg={theme.dim}>{yAxis(index, plotRows, chart.max)}</span>{line.map((segment, segmentIndex) => (
            <span key={segmentIndex} fg={segment.fg} bg={segment.bg}>{segment.text}</span>
          ))}</text>
        ))}
        <text fg={theme.muted}>{pad}{xLabels(axisRows, plotWidth, (index) => {
          const bins = chart.edges.length - 1;
          const bin = Math.min(bins - 1, Math.floor(index * bins / rows.length));
          return (chart.edges[bin]! + chart.edges[bin + 1]! - 1) / 2;
        })}</text>
      </>
    );
  } else if (chartType === "spark") {
    const sparkSeries: Array<{ values: number[]; color: string }> = [{ values: messages, color: theme.cyan }, { values: calls, color: theme.violet }];
    if (cumulative || unique) {
      if (plotRows < 3) sparkSeries.length = 0;
      sparkSeries.push({ values: eventSeries, color: theme.ink });
    }
    const separators = plotRows >= sparkSeries.length * 2 - 1;
    const availableRows = plotRows - (separators ? sparkSeries.length - 1 : 0);
    const sparkEdges = slotEdges(Math.min(rows.length, plotWidth), plotWidth);
    const axis = (index: number, max: number) => index === 0 ? `${compactNumber(max).padStart(yAxisWidth - 2)} ┤` : `${" ".repeat(yAxisWidth - 2)} │`;
    body = (
      <>
        {sparkSeries.map((series, seriesIndex) => {
          const from = Math.floor(seriesIndex * availableRows / sparkSeries.length);
          const through = Math.floor((seriesIndex + 1) * availableRows / sparkSeries.length);
          return <box key={seriesIndex} flexDirection="column">
            {seriesIndex > 0 && separators && <text fg={theme.dim}>{pad}{"─".repeat(plotWidth)}</text>}
            {blockSparkline(spread(series.values, plotWidth, cumulative), plotWidth, through - from).map((line, index) => (
              <text key={index} onMouseDown={(event) => selectPlot(event, sparkEdges.length - 1, sparkEdges)}><span fg={theme.dim}>{axis(index, Math.max(0, ...series.values.filter(Number.isFinite)))}</span><span fg={series.color}>{line}</span></text>
            ))}
          </box>;
        })}
        <text fg={theme.muted}>{pad}{xLabels(axisRows, plotWidth, (index) => {
          const bin = Math.min(sparkEdges.length - 2, Math.floor(index * (sparkEdges.length - 1) / rows.length));
          return (sparkEdges[bin]! + sparkEdges[bin + 1]! - 1) / 2;
        })}</text>
      </>
    );
  } else {
    const dateWidth = interval === "weekly" ? 11 : 10;
    const countWidth = Math.max(6, Math.min(9, Math.floor((contentWidth - 16) / 7)));
    const columns: Array<[string, (row: TrafficRow) => number]> = direction === "both"
      ? [["MSG IN", (row) => row.msgIn], ["MSG OUT", (row) => row.msgOut], ["CALL IN", (row) => row.callIn], ["CALL OUT", (row) => row.callOut]]
      : [[unique ? requestedDirection === "in" ? "TEXTERS" : "TEXT #" : "MESSAGES", (row) => pick(row, direction).messages], [unique ? requestedDirection === "in" ? "CALLERS" : "CALL #" : "CALLS", (row) => pick(row, direction).calls]];
    const barWidth = Math.max(0, contentWidth - dateWidth - 3 - (countWidth + 1) * (columns.length + 1) - 2);
    const max = Math.max(1, ...totals);
    const ordered = rows.map((row, index) => ({ row, index })).reverse().slice(0, plotRows);
    body = (
      <>
        <text fg={theme.muted} wrapMode="none">{`${interval === "weekly" ? "WEEK" : "DATE"} ${timeZone.toUpperCase()}`.padEnd(dateWidth + 1)}  {columns.map(([label]) => label.padStart(countWidth)).join(" ")} {(unique ? "CONTACTS" : "TOTAL").padStart(countWidth)}</text>
        {ordered.map(({ row, index }) => {
          const value = series[index]!;
          const uncertain = row.coverage && row.coverage !== "complete";
          const shown = (value: number) => row.coverage === "missing" ? "—" : `${uncertain ? "≥" : ""}${formatNumber(value)}`;
          return (
            <text key={row.date} wrapMode="none" onMouseDown={() => selectRows(index, index)}>
              <span fg={uncertain || spikes[index] ? theme.amber : theme.ink}>{(interval === "weekly" ? `${shortDate(row.date)}–${shortDate(row.endDate ?? row.date)}` : row.date).padEnd(dateWidth)}{row.inProgress ? " *" : uncertain ? " ?" : spikes[index] ? " ⚑" : "  "}</span>
              <span fg={theme.ink}> {columns.map(([, get]) => shown(get(row)).padStart(countWidth)).join(" ")} {shown(totals[index]!).padStart(countWidth)}  </span>
              <span fg={unique ? theme.ink : theme.cyan}>{!plottable(row) ? "░".repeat(barWidth) : "█".repeat(Math.round((unique ? totals[index]! : value.messages) / max * barWidth))}</span>
              <span fg={theme.violet}>{!plottable(row) || unique ? "" : "█".repeat(Math.round(value.calls / max * barWidth))}</span>
            </text>
          );
        })}
      </>
    );
  }

  if (chartType !== "table" && rows.length && rows.every((row) => !plottable(row))) {
    body = <box flexGrow={1} flexDirection="column" justifyContent="center">
      <text fg={theme.amber} wrapMode="none">{clipText("Chart hidden by missing history", contentWidth)}</text>
      {contentHeight >= 6 && <text fg={theme.muted} wrapMode="none">{clipText(cumulative
        ? "Cumulative totals need every day from the start."
        : "These periods have incomplete saved data.", contentWidth)}</text>}
      <box height={1} flexDirection="row">
        {cumulative && onToggleMode && <Tab label="Period counts" active={false} onClick={onToggleMode} />}
        {onDownload && <Tab label="Download window" active={false} onClick={onDownload} />}
      </box>
      {contentHeight >= 5 && <box height={1} flexDirection="row">
        {onChooseDates && <Tab label="Choose dates" active={false} onClick={onChooseDates} />}
        {onShowActivity && <Tab label="View activity" active={false} onClick={onShowActivity} />}
      </box>}
    </box>;
  }

  return (
    <Panel title={clipText(unique ? `UNIQUE CONTACTS · ${title}` : title, Math.max(10, width - 6))} width={width} height={height}>
      {legend}
      {body}
    </Panel>
  );
}

export function LineTable({ lines, dates, direction, loaded, width, height, cursorIndex, detailKey, showProfile, filter, filteredOut, onRowClick, onScroll, complete = true, comparisonComplete = true, coverageRows = [], unique = false }: {
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
  onScroll?: (step: number) => void;
  complete?: boolean;
  comparisonComplete?: boolean;
  coverageRows?: TrafficRow[];
  unique?: boolean;
}) {
  const contentWidth = Math.max(20, width - 4);
  const visibleRows = Math.max(1, height - 4);
  const firstIndex = Math.max(0, Math.min(cursorIndex - Math.floor(visibleRows / 2), lines.length - visibleRows));
  const entries = lines.slice(firstIndex, firstIndex + visibleRows);

  const longestName = Math.max(4, ...lines.map((entry) => entry.name?.length ?? (entry.owned ? 1 : 16)));
  const numberWidth = Math.min(Math.max(12, ...lines.map((entry) => entry.number.length)), 18);
  const deltaWidth = !unique && contentWidth >= 60 ? 6 : 0;
  const profileWidth = showProfile
    ? Math.max(6, Math.min(14, Math.max(7, ...lines.map((entry) => (entry.profile ?? "active").length))))
    : 0;
  const layout = (split: boolean) => {
    const columnWidth = unique ? 8 : split ? 8 : contentWidth >= 70 ? 7 : 6;
    const metricCount = split ? 4 : 2;
    const fixed = 2 + (showProfile ? profileWidth + 2 : 0) + (columnWidth + 1) * (metricCount + 1) + (deltaWidth ? deltaWidth + 1 : 0) + 3;
    return { split, columnWidth, free: contentWidth - fixed - numberWidth - 1 };
  };
  // Prefer in/out columns when names still get a readable width.
  const splitLayout = layout(true);
  const { split, columnWidth, free } = direction === "both" && splitLayout.free >= Math.min(longestName, 22) + 1 ? splitLayout : layout(false);
  const metrics: Array<[string, (line: Counts) => number, string]> = split
    ? [
      ["TEXT IN", (line) => line.msgIn, theme.cyan],
      ["TEXT OUT", (line) => line.msgOut, theme.cyan],
      ["CALL IN", (line) => line.callIn, theme.violet],
      ["CALL OUT", (line) => line.callOut, theme.violet],
    ]
    : [
      [unique ? "TEXT #" : "TEXTS", (line) => pick(line, direction).messages, theme.cyan],
      [unique ? "CALL #" : "CALLS", (line) => pick(line, direction).calls, theme.violet],
    ];
  // Names get priority (up to 28 cells); the trend sparkline uses the rest when it can get at least 8.
  const nameWidth = Math.max(0, Math.min(longestName, free >= 44 ? 32 : free));
  const showName = nameWidth >= 8;
  const trendWidth = Math.max(0, free - (showName ? nameWidth + 1 : 0) - 2);
  const showTrend = trendWidth >= 8;
  const coverageByDate = new Map(coverageRows.map((row) => [row.date, row]));

  const header = [
    "  ",
    showProfile ? `${"ACCOUNT".padEnd(profileWidth)}  ` : "",
    showName ? `${"NAME".padEnd(nameWidth)} ` : "",
    "NUMBER".padEnd(numberWidth),
    " ",
    metrics.map(([label]) => label.padStart(columnWidth)).join(" "),
    " ",
    (unique ? "CONTACTS" : "EVENTS").padStart(columnWidth),
    deltaWidth ? ` ${"Δ".padStart(deltaWidth)}` : "",
    "   ",
    showTrend ? `  ${"TREND".padEnd(trendWidth)}` : "",
  ].join("");

  const title = filter
    ? `LINES · ${formatNumber(lines.length)} matching "${filter}"`
    : `LINES · ${formatNumber(lines.length)}${unique ? " · UNIQUE CONTACTS" : ""}`;

  return (
    <Panel title={title} width={width} height={height} active={!!filter} onMouseScroll={(event) => onScroll?.(mouseScrollStep(event))}>
      <text fg={theme.muted} wrapMode="none">{clipText(header, contentWidth)}</text>
      {entries.length ? entries.map((entry, index) => {
        const actualIndex = firstIndex + index;
        const selected = actualIndex === cursorIndex;
        const open = entry.key === detailKey;
        const total = totalOf(entry, direction);
        const change = complete && comparisonComplete ? percentChange(total, totalOf(entry.previous, direction)) : { text: "—", color: theme.muted };
        const values = dates.map((date) => {
          const coverage = coverageByDate.get(date);
          if (coverage && !plottable(coverage)) return NaN;
          const day = entry.daily[date];
          return day ? totalOf(day, direction) : 0;
        });
        const spikeCount = complete ? spikeFlags(values).filter(Boolean).length : 0;
        const quiet = total === 0;
        return (
          <box key={entry.key} height={1} backgroundColor={selected ? theme.selection : undefined} onMouseDown={() => onRowClick(actualIndex)}>
            <text wrapMode="none">
              <span fg={selected ? theme.cyan : theme.dim}>{open ? "● " : selected ? "› " : "  "}</span>
              {showProfile && <span fg={theme.muted}>{clipText(entry.profile ?? "active", profileWidth).padEnd(profileWidth)}  </span>}
              {showName && <span fg={selected ? theme.cyan : entry.name ? quiet ? theme.muted : theme.ink : theme.dim}>{clipText(entry.name ?? (entry.owned ? "—" : entry.number === "Unknown" ? "(no number)" : "(not on account)"), nameWidth).padEnd(nameWidth)} </span>}
              <span fg={selected ? theme.cyan : showName || quiet ? theme.muted : theme.ink}>{clipText(entry.number, numberWidth).padEnd(numberWidth)} </span>
              {metrics.map(([label, get, color]) => (
                <span key={label} fg={get(entry) ? color : theme.dim}>{`${complete ? "" : "≥"}${formatNumber(get(entry))}`.padStart(columnWidth)} </span>
              ))}
              <span fg={quiet ? theme.dim : theme.ink}>{`${complete ? "" : "≥"}${formatNumber(total)}`.padStart(columnWidth)}</span>
              {deltaWidth > 0 && <span fg={change.color}> {change.text.padStart(deltaWidth)}</span>}
              <span fg={theme.amber}>{spikeCount ? ` ⚑${spikeCount > 9 ? "+" : spikeCount}` : "   "}</span>
              {showTrend && <span fg={selected ? theme.cyan : theme.muted}>  {quiet && complete ? "" : sparkline(values, trendWidth)}</span>}
            </text>
          </box>
        );
      }) : (
        <text fg={theme.muted}>{!loaded ? "Waiting for account data…" : !complete ? "No matching saved lines in this window. U previews missing history." : filter ? `No lines in this view match "${filter}". Press / to change the filter, or Tab / A to switch account.` : "No phone numbers or traffic found for this account."}</text>
      )}
      <box flexGrow={1} />
      <text fg={theme.dim} wrapMode="none">
        {clipText([
          lines.length > entries.length ? `${firstIndex + 1}–${firstIndex + entries.length} of ${formatNumber(lines.length)}` : "",
          filteredOut > 0 ? `${formatNumber(filteredOut)} hidden by filter` : "",
          "/ filter",
          "↑↓ select · Enter campaign totals",
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
      <text fg={theme.muted}>{footer}</text>
    </box>
  );
}

function scrollWindow(cursor: number, count: number, visible: number): number {
  return Math.max(0, Math.min(cursor - Math.floor(visible / 2), count - visible));
}

export function ProfilePicker({ profiles, selected, cursor, loading, error, height, width = 80, confirmForget = null, notice,
  onToggle, onDone, onCancel, onForget, onConfirmForget, onCancelForget, onScroll, onAll, onActive, onReload }: {
  profiles: CliProfile[];
  selected: string[];
  cursor: number;
  loading: boolean;
  error: string | null;
  height: number;
  width?: number;
  confirmForget?: string | null;
  notice?: string | null;
  onToggle?: (id: string) => void;
  onDone?: () => void;
  onCancel?: () => void;
  onForget?: () => void;
  onConfirmForget?: () => void;
  onCancelForget?: () => void;
  onScroll?: (step: number) => void;
  onAll?: () => void;
  onActive?: () => void;
  onReload?: () => void;
}) {
  const visibleRows = Math.max(1, height - 13 - (confirmForget !== null ? 4 : 0) - Number(!!notice));
  const firstIndex = scrollWindow(cursor, profiles.length, visibleRows);
  const visibleProfiles = profiles.slice(firstIndex, firstIndex + visibleRows);

  return (
    <Screen
      title="MANAGE ACCOUNTS"
      subtitle="Choose which saved Twilio CLI profiles (accounts) to load. The account bar then lets you view them one at a time or all together."
      footer="↑↓ choose · Space toggle · F forget · D done · Esc cancel"
    >
      <box height={1} flexDirection="row" gap={1} marginY={1}>
        {confirmForget === null && <Tab label="D SAVE & BACK" active={false} onClick={() => onDone?.()} />}
        <Tab label="Esc CANCEL" active={false} onClick={() => { if (confirmForget !== null) onCancelForget?.(); else onCancel?.(); }} />
        {confirmForget === null && <Tab label="F FORGET SELECTED" active={false} onClick={() => onForget?.()} />}
      </box>
      <Panel title={`ACCOUNTS · ${selected.length || "active CLI profile"} selected`} onMouseScroll={(event) => { if (confirmForget === null) onScroll?.(mouseScrollStep(event)); }}>
        {confirmForget === null && <box height={1} flexDirection="row">
          <Tab label="All connected" active={false} onClick={() => onAll?.()} />
          <Tab label="Active CLI" active={false} onClick={() => onActive?.()} />
          <Tab label="Reload" active={false} onClick={() => onReload?.()} />
        </box>}
        {confirmForget !== null && <>
          <text fg={theme.amber}>Forget {confirmForget}? Removes its local traffic and selection. CLI credentials stay saved.</text>
          <box height={1} flexDirection="row" gap={1}>
            <Tab label="Y confirm" active={false} onClick={() => onConfirmForget?.()} accent={theme.red} />
            <Tab label="N/Esc cancel" active={false} onClick={() => onCancelForget?.()} />
          </box>
        </>}
        {notice && <text fg={theme.amber}>{notice}</text>}
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
            <box key={profile.id} height={1} backgroundColor={current ? theme.selection : undefined}
              onMouseDown={() => { if (confirmForget === null) onToggle?.(profile.id); }}>
              <text wrapMode="none">
                <span fg={current ? theme.cyan : theme.dim}>{current ? "› " : "  "}</span>
                <span fg={checked ? theme.cyan : theme.muted}>{checked ? "[✓] " : "[ ] "}</span>
                <span fg={current ? theme.cyan : theme.ink}>{clipText(profile.id, Math.min(32, Math.max(12, width - 44))).padEnd(Math.min(32, Math.max(12, width - 44)))}</span>
                {width >= 115 && <span fg={theme.muted}>{profile.accountSid ?? ""}</span>}
                {profile.active && <span fg={theme.amber}>  active</span>}
                {profile.disconnected && <span fg={theme.red}>  disconnected · saved locally</span>}
              </text>
            </box>
          );
        })}
        <box flexGrow={1} />
        <text fg={theme.dim} wrapMode="none">A all connected · C active CLI · R reload · untick to keep saved data</text>
        {profiles.length > visibleProfiles.length && (
          <text fg={theme.dim}>Showing {firstIndex + 1}–{firstIndex + visibleProfiles.length} of {profiles.length}</text>
        )}
      </Panel>
    </Screen>
  );
}

export function ExclusionsScreen({ peers, excluded, cursor, input, adding, height, width, onToggle, onAdd, onApply, onCancelAdd, onClose, onScroll }: {
  peers: PeerTraffic[];
  excluded: string[];
  cursor: number;
  input: string;
  adding: boolean;
  height: number;
  width: number;
  onToggle?: (number: string, index: number) => void;
  onAdd?: () => void;
  onApply?: () => void;
  onCancelAdd?: () => void;
  onClose?: () => void;
  onScroll?: (step: number) => void;
}) {
  const rows = exclusionRows(peers, excluded);
  const visibleRows = Math.max(3, height - 13);
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
      <box height={1} flexDirection="row">
        {adding ? <>
          <Tab label="Add number" active onClick={() => onApply?.()} />
          <Tab label="Cancel entry" active={false} onClick={() => onCancelAdd?.()} />
        </> : <Tab label="N Add number" active={false} onClick={() => onAdd?.()} />}
        <Tab label="Done" active={false} onClick={() => onClose?.()} />
      </box>
      <Panel title={`OUTSIDE NUMBERS · ${excluded.length} excluded · sorted by traffic in range`} onMouseScroll={(event) => { if (!adding) onScroll?.(mouseScrollStep(event)); }}>
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
            <box key={row.number} height={1} backgroundColor={current ? theme.selection : undefined} onMouseDown={() => { if (!adding) onToggle?.(row.number, actualIndex); }}>
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
      ["Space", "Open the actions menu: arrows choose, Return opens"],
      ["0 1 2 3 4 5 6  ← →", "1, 7, 30, 90, 180 days, 1 year or 2 years"],
      ["W", "Dates: exact range, month to date (MTD), quarter to date (QTD)"],
      ["S", "Saved views: save or restore accounts, filters, dates and charts"],
      ["- / = / +", "Previous / next whole time window (Mac friendly)"],
      ["PageUp PageDown", "Optional: move window or page through activity"],
      ["C", "Cumulative / period counts; shows cumulative chart if hidden"],
      ["I", "Daily / weekly chart grouping (Monday–Sunday, selected dates only)"],
      ["N", "Events / unique contacts; phone numbers counted once across channels"],
      ["G", "Hide / show the chart; campaign totals stay visible"],
      ["V / M", "Lines / activity; all events / messages / calls"],
      ["D", "Direction: in + out, incoming only, outgoing only"],
      ["T", "Chart: line, stacked bars, sparklines, daily or weekly table"],
      ["Z", "Day boundaries in UTC or local time"],
    ],
  },
  {
    title: "ACCOUNTS",
    rows: [
      ["Tab  ⇧Tab  ] [", "Show one account at a time (next / previous)"],
      ["A", "Show all loaded accounts combined"],
      ["P / F", "Manage accounts; F there forgets a saved account"],
    ],
  },
  {
    title: "LINES",
    rows: [
      ["↑ ↓  j k", "Select a line (steps lines while in detail)"],
      ["Enter / click", "Campaign totals; Enter in activity opens the selected record"],
      ["Backspace / Esc", "Back from line detail or activity; Q quits"],
      ["/", "Filter by name or number: a, b = either · -word hides"],
      ["Ctrl+U", "Clear the filter"],
      ["X", "Exclude outside numbers (test phones) from all counts"],
    ],
  },
  {
    title: "OTHER",
    rows: [
      [", / . / H", "Saved history: older week / newer week / today"],
      ["< / >", "Saved history: older month / newer month"],
      ["E", "Export CSV (twilio-tui-<timestamp>.csv)"],
      ["R / ⇧R", "Refresh now / reload selected range (keeps saved history)"],
      ["B", "History downloads: accounts, oldest date, pace, start/pause"],
      ["U", "Preview missing days and download the viewed window"],
      ["?", "Toggle this help"],
      ["Q", "Quit"],
    ],
  },
];

export const helpNotes = [
  "Mac: use Space, arrows and Return; no function keys needed.",
  "Mac Delete works as Backspace; F forgets an account.",
  "Tabs, the account bar and line rows are clickable.",
  "Δ compares with the previous period of the same length.",
  "⚑ marks days with at least 3× the daily average.",
  "Accounts, the account in view, the filter and exclusions are saved.",
];

export function HelpOverlay({ width, height, onClose, onActions }: { width: number; height: number; onClose?: () => void; onActions?: () => void }) {
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
      <box height={1} flexShrink={0} flexDirection="row" justifyContent="space-between">
        <text fg={theme.muted} wrapMode="none">↑↓ scroll · mouse wheel</text>
        <box flexDirection="row">
          <Tab label="Actions" active={false} onClick={() => onActions?.()} />
          <Tab label="Close help" active={false} onClick={() => onClose?.()} />
        </box>
      </box>
      <scrollbox flexGrow={1} minHeight={0} focused scrollX={false}>
      {helpSections.map((section) => (
        <box key={section.title} flexDirection="column">
          <text fg={theme.muted} wrapMode="none"><strong>{section.title}</strong></text>
          {section.rows.map(([keys, label]) => (
            <box key={keys} flexDirection="column" marginBottom={1}>
              <text fg={theme.cyan}>{keys}</text>
              <text fg={theme.ink}>{label}</text>
            </box>
          ))}
        </box>
      ))}
      <box flexGrow={1} minHeight={1} />
      {helpNotes.map((note) => <text key={note} fg={theme.muted}>{note}</text>)}
      </scrollbox>
    </box>
  );
}
