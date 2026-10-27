import { validDay, type CalendarPreset, type ChartInterval, type DirectionMode, type TimeZoneMode } from "./aggregate";

export type SavedView = {
  name: string;
  profiles: string[];
  focus: string | null;
  filter: string;
  excluded: string[];
  period: number;
  endDay: string | null;
  calendarPreset: CalendarPreset | null;
  timeZone: TimeZoneMode;
  direction: DirectionMode;
  chartType: "line" | "bars" | "spark" | "table";
  chartInterval: ChartInterval;
  cumulative: boolean;
  chartVisible: boolean;
  unique: boolean;
  line?: { key: string; number: string; name?: string; profile?: string };
};

/** Ignore invalid saved entries without losing other settings or views. */
export function parseSavedViews(value: unknown): SavedView[] {
  if (!Array.isArray(value)) return [];
  const result: SavedView[] = [];
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const view = entry as Record<string, unknown>;
    if (typeof view.name !== "string" || !view.name.trim() || view.name.trim().length > 80
      || !strings(view.profiles) || !strings(view.excluded) || typeof view.filter !== "string"
      || !(view.focus === null || typeof view.focus === "string")
      || !Number.isInteger(view.period) || Number(view.period) < 1 || Number(view.period) > 3660
      || !(view.endDay === null || typeof view.endDay === "string" && validDay(view.endDay))
      || !(view.calendarPreset === null || view.calendarPreset === "mtd" || view.calendarPreset === "qtd")
      || !["utc", "local"].includes(String(view.timeZone)) || !["in", "out", "both"].includes(String(view.direction))
      || !["line", "bars", "spark", "table"].includes(String(view.chartType))
      || !["daily", "weekly"].includes(String(view.chartInterval))
      || [view.cumulative, view.chartVisible, view.unique].some((value) => typeof value !== "boolean")) continue;
    const name = view.name.trim();
    if (result.some((saved) => saved.name.toLowerCase() === name.toLowerCase())) continue;
    const line = view.line as Record<string, unknown> | undefined;
    result.push({
      name, profiles: [...view.profiles], focus: view.focus as string | null, filter: view.filter, excluded: [...view.excluded],
      period: Number(view.period), endDay: view.endDay as string | null, calendarPreset: view.calendarPreset as CalendarPreset | null,
      timeZone: view.timeZone as TimeZoneMode, direction: view.direction as DirectionMode,
      chartType: view.chartType as SavedView["chartType"], chartInterval: view.chartInterval as ChartInterval,
      cumulative: view.cumulative as boolean, chartVisible: view.chartVisible as boolean, unique: view.unique as boolean,
      ...(line && typeof line.key === "string" && typeof line.number === "string" ? {
        line: { key: line.key, number: line.number, ...(typeof line.name === "string" ? { name: line.name } : {}),
          ...(typeof line.profile === "string" ? { profile: line.profile } : {}) },
      } : {}),
    });
  }
  return result;
}

export function saveNamedView(views: SavedView[], view: SavedView): SavedView[] {
  const name = view.name.trim();
  if (!name || name.length > 80) throw new Error("Choose a name between 1 and 80 characters");
  return [...views.filter((saved) => saved.name.toLowerCase() !== name.toLowerCase()), { ...view, name }]
    .sort((a, b) => a.name.localeCompare(b.name));
}
