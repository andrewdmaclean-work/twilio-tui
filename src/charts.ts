export type Segment = { text: string; fg: string; bg?: string };
export type ChartLine = Segment[];

/** Resamples a series to `count` points by averaging buckets (or repeating when stretching). */
export function resample(values: number[], count: number, mode: "mean" | "sum" = "mean"): number[] {
  const size = Math.max(1, Math.floor(count));
  if (!values.length) return Array.from({ length: size }, () => 0);
  if (values.length <= size && mode === "mean") return values.slice();
  return Array.from({ length: Math.min(size, values.length) }, (_, index) => {
    const from = Math.floor(index * values.length / Math.min(size, values.length));
    const to = Math.max(from + 1, Math.floor((index + 1) * values.length / Math.min(size, values.length)));
    const bucket = values.slice(from, to);
    const sum = bucket.reduce((total, value) => total + value, 0);
    return mode === "sum" ? sum : sum / bucket.length;
  });
}

/** Rounds a maximum up to a readable axis value (1, 2, 2.5, 5 × 10ⁿ). */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

export function compactNumber(value: number): string {
  if (Math.abs(value) < 1000) return String(Math.round(value * 10) / 10);
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function joinSegments(cells: Segment[]): ChartLine {
  const line: ChartLine = [];
  for (const cell of cells) {
    const last = line.at(-1);
    if (last && last.fg === cell.fg && last.bg === cell.bg) last.text += cell.text;
    else line.push({ ...cell });
  }
  return line;
}

// Braille dot bits indexed by [row][column] within a 2×4 cell.
const brailleBits = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

/**
 * Draws one or more series as connected lines using braille characters, which
 * give 2×4 dots per terminal cell. Cells where series cross use `overlapColor`.
 */
export function brailleLineChart(
  series: Array<{ values: number[]; color: string }>,
  width: number,
  height: number,
  max: number,
  { overlapColor, emptyColor }: { overlapColor: string; emptyColor: string },
): ChartLine[] {
  const cols = Math.max(1, Math.floor(width));
  const rows = Math.max(1, Math.floor(height));
  const dotsX = cols * 2;
  const dotsY = rows * 4;
  const masks = series.map(() => new Uint8Array(cols * rows));

  series.forEach((entry, seriesIndex) => {
    const values = resample(entry.values, dotsX);
    const mask = masks[seriesIndex]!;
    const plot = (x: number, y: number) => {
      const cell = Math.floor(y / 4) * cols + Math.floor(x / 2);
      mask[cell]! |= brailleBits[y % 4]![x % 2]!;
    };
    const points = values.map((value, index) => ({
      x: values.length === 1 ? Math.floor(dotsX / 2) : Math.round(index * (dotsX - 1) / (values.length - 1)),
      y: dotsY - 1 - Math.round(Math.min(1, Math.max(0, value / max)) * (dotsY - 1)),
    }));
    points.forEach((point, index) => {
      const next = points[index + 1];
      if (!next) {
        plot(point.x, point.y);
        return;
      }
      // Bresenham line between neighbouring points.
      let { x, y } = point;
      const dx = Math.abs(next.x - x);
      const dy = -Math.abs(next.y - y);
      const sx = x < next.x ? 1 : -1;
      const sy = y < next.y ? 1 : -1;
      let error = dx + dy;
      for (;;) {
        plot(x, y);
        if (x === next.x && y === next.y) break;
        const doubled = 2 * error;
        if (doubled >= dy) { error += dy; x += sx; }
        if (doubled <= dx) { error += dx; y += sy; }
      }
    });
  });

  return Array.from({ length: rows }, (_, row) => joinSegments(Array.from({ length: cols }, (_, col) => {
    const cell = row * cols + col;
    let bits = 0;
    const owners: string[] = [];
    masks.forEach((mask, index) => {
      if (mask[cell]) {
        bits |= mask[cell]!;
        owners.push(series[index]!.color);
      }
    });
    if (!bits) return { text: " ", fg: emptyColor };
    return { text: String.fromCharCode(0x2800 + bits), fg: owners.length > 1 ? overlapColor : owners[0]! };
  })));
}

const lowerBlocks = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Splits `width` cells into `count` near-equal slots and returns each slot's start column (plus the end). */
export function slotEdges(count: number, width: number): number[] {
  return Array.from({ length: count + 1 }, (_, index) => Math.round(index * width / Math.max(1, count)));
}

/** Repeats each value across its slot so a short series fills the whole width. */
export function spread(values: number[], width: number): number[] {
  if (values.length >= width) return resample(values, width);
  const edges = slotEdges(values.length, width);
  return values.flatMap((value, index) => Array.from({ length: edges[index + 1]! - edges[index]! }, () => value));
}

/**
 * Vertical stacked columns: `bottom` values are drawn first, `top` values stacked
 * above them. Columns are spread across the full width; `edges` gives each column's start.
 */
export function stackedColumns(
  bottom: number[],
  top: number[],
  width: number,
  height: number,
  { bottomColor, topColor, emptyColor }: { bottomColor: string; topColor: string; emptyColor: string },
): { lines: ChartLine[]; max: number; edges: number[] } {
  const cols = Math.max(1, Math.floor(width));
  const rows = Math.max(1, Math.floor(height));
  const bins = Math.min(bottom.length || 1, cols);
  const lower = resample(bottom, bins, "sum");
  const upper = resample(top, bins, "sum");
  const edges = slotEdges(bins, cols);
  const useGaps = cols / bins >= 3;
  const max = niceMax(Math.max(1, ...lower.map((value, index) => value + upper[index]!)));

  const lines = Array.from({ length: rows }, (_, rowIndex) => {
    const row = rows - rowIndex - 1;
    const cells: Segment[] = [];
    for (let bin = 0; bin < bins; bin++) {
      const total = lower[bin]! + upper[bin]!;
      const bottomEighths = Math.round(lower[bin]! / max * rows * 8);
      let totalEighths = Math.round(total / max * rows * 8);
      if (total > 0 && totalEighths === 0) totalEighths = 1;
      const cellStart = row * 8;
      const bottomFill = Math.max(0, Math.min(8, bottomEighths - cellStart));
      const totalFill = Math.max(0, Math.min(8, totalEighths - cellStart));
      let cell: Segment;
      if (totalFill === 0) cell = { text: row === 0 ? "▁" : " ", fg: emptyColor };
      else if (bottomFill >= 8) cell = { text: "█", fg: bottomColor };
      else if (bottomFill === 0) cell = { text: lowerBlocks[totalFill]!, fg: topColor };
      else if (totalFill === 8) cell = { text: lowerBlocks[bottomFill]!, fg: bottomColor, bg: topColor };
      else cell = { text: lowerBlocks[totalFill]!, fg: bottomFill * 2 >= totalFill ? bottomColor : topColor };
      const slot = edges[bin + 1]! - edges[bin]!;
      const gap = useGaps && slot >= 2 ? 1 : 0;
      for (let repeat = 0; repeat < slot - gap; repeat++) cells.push(cell);
      if (gap) cells.push({ text: " ", fg: emptyColor });
    }
    return joinSegments(cells);
  });
  return { lines, max, edges };
}

const sparkBlocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** A single-row sparkline using block heights. */
export function sparkline(values: number[], width: number): string {
  const points = spread(values, width);
  const max = Math.max(...points, 0);
  if (max <= 0) return "·".repeat(points.length);
  return points.map((value) => value <= 0 ? " " : sparkBlocks[Math.min(7, Math.floor(value / max * 7.999))]!).join("");
}

/** Multi-row block sparkline (independent scale per series). */
export function blockSparkline(values: number[], width: number, height: number): string[] {
  const points = resample(values, width);
  const max = Math.max(1, ...points);
  const rows = Math.max(1, Math.floor(height));
  const heights = points.map((value) => value > 0 ? Math.max(1, Math.round(value / max * rows * 8)) : 0);
  return Array.from({ length: rows }, (_, rowIndex) => {
    const row = rows - rowIndex - 1;
    return heights.map((height) => {
      const fill = Math.max(0, Math.min(8, height - row * 8));
      if (fill === 0) return row === 0 && height === 0 ? "·" : " ";
      return lowerBlocks[fill]!;
    }).join("");
  });
}

/** Places labels along an axis of `width` cells; each label is centred on its position and never overlaps. */
export function axisLabels(labels: Array<{ at: number; text: string }>, width: number): string {
  const line = Array.from({ length: width }, () => " ");
  let nextFree = 0;
  for (const label of labels) {
    let start = Math.round(label.at - label.text.length / 2);
    start = Math.max(0, Math.min(width - label.text.length, start));
    if (start < nextFree || label.text.length > width) continue;
    for (let index = 0; index < label.text.length; index++) line[start + index] = label.text[index]!;
    nextFree = start + label.text.length + 1;
  }
  return line.join("");
}
