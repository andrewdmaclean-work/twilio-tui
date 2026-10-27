import { dayKey, shiftDay, type TrafficEvent } from "./aggregate";
import type { ImportProgress } from "./backfill";

export type ApiImportState = { startDay: string; initialDay: string; nextDay: string; accountStart?: string };
export type ApiImportBackend = {
  getState(id: string): ApiImportState | null;
  saveState(id: string, state: ApiImportState): void;
  coverage(id: string): string | null;
  hasDay?(id: string, day: string): boolean;
  accountStart(profile: string | undefined, signal: AbortSignal): Promise<string>;
  fetchDay(profile: string | undefined, day: string, signal: AbortSignal): Promise<TrafficEvent[]>;
  commit(id: string, day: string, events: TrafficEvent[], state: ApiImportState): void;
  nextPullAt(): number;
  setNextPullAt(time: number): void;
};

/** Use the common readable window for both resources, avoiding a partly expired oldest day. */
export function apiHistoryBoundary(now: number): string {
  const date = new Date(now);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - 13);
  const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, monthEnd));
  const calls = dayKey(date, "utc");
  const messages = shiftDay(dayKey(new Date(now), "utc"), -400);
  return shiftDay(calls > messages ? calls : messages, 1);
}

const days = (from: string, through: string) => Math.max(0, Math.round((Date.parse(through) - Date.parse(from)) / 86_400_000) + 1);

/** Read-only history pulls. This worker has no export-job creation capability. */
export class ApiHistoryImporter {
  private cursor = 0;
  private retryAt = 0;
  private failures = 0;
  constructor(private backend: ApiImportBackend, private profiles: string[], private now = () => Date.now(), private options: { startDay?: string; endDay?: string; intervalMs?: number } = {}) {}

  async step(signal: AbortSignal, onProgress?: (progress: ImportProgress) => void): Promise<ImportProgress> {
    signal.throwIfAborted();
    const ids = this.profiles.length ? this.profiles : [""];
    let current = ids[this.cursor % ids.length]!;
    let day: string | undefined;
    const progress = (phase: ImportProgress["phase"], message: string): ImportProgress => {
      let total = 0, completed = 0;
      for (const id of ids) {
        const state = this.backend.getState(id);
        if (this.options.endDay && this.backend.hasDay) {
          const start = [this.options.startDay ?? "", apiHistoryBoundary(this.now()), state?.accountStart ?? ""].sort().at(-1)!;
          const yesterday = shiftDay(dayKey(new Date(this.now()), "utc"), -1);
          const end = this.options.endDay < yesterday ? this.options.endDay : yesterday;
          total += days(start, end);
          for (let key = start; key <= end; key = shiftDay(key, 1)) if (this.backend.hasDay(id, key)) completed++;
        } else if (state) {
          total += days(state.startDay, state.initialDay);
          completed += days(shiftDay(state.nextDay, 1), state.initialDay);
        }
      }
      return { phase, message, total, completed: Math.min(total, completed), profile: current || "active", day };
    };
    if (this.now() < this.retryAt) return progress("retrying", `API retry in ${Math.ceil((this.retryAt - this.now()) / 1000)}s`);
    try {
      let selected: ApiImportState | null = null;
      for (let offset = 0; offset < ids.length; offset++) {
        current = ids[(this.cursor + offset) % ids.length]!;
        const coverage = this.backend.coverage(current);
        if (!coverage && !this.options.endDay) continue;
        let state = this.backend.getState(current);
        const retention = apiHistoryBoundary(this.now());
        const boundary = this.options.startDay && this.options.startDay > retention ? this.options.startDay : retention;
        if (!state?.accountStart) {
          onProgress?.(progress("starting", "Reading API history start date"));
          const accountStart = await this.backend.accountStart(current || undefined, signal);
          signal.throwIfAborted();
          const nextDay = this.options.endDay ?? shiftDay(coverage!, -1);
          state = { startDay: accountStart > boundary ? accountStart : boundary, initialDay: state?.initialDay ?? nextDay, nextDay, accountStart };
          this.backend.saveState(current, state);
        } else {
          // Changing the target can extend a completed download as well as shorten it.
          const startDay = state.accountStart && state.accountStart > boundary ? state.accountStart : boundary;
          state = { ...state, nextDay: this.options.endDay ?? shiftDay(coverage!, -1), startDay };
          this.backend.saveState(current, state);
        }
        if (this.options.endDay) {
          const yesterday = shiftDay(dayKey(new Date(this.now()), "utc"), -1);
          state.initialDay = this.options.endDay < yesterday ? this.options.endDay : yesterday;
          state.nextDay = state.initialDay;
          if (!this.backend.hasDay) throw new Error("Window downloads require saved-day coverage");
          while (state.nextDay >= state.startDay && this.backend.hasDay(current, state.nextDay)) state.nextDay = shiftDay(state.nextDay, -1);
          this.backend.saveState(current, state);
        }
        if (state.nextDay >= state.startDay) { selected = state; break; }
      }
      if (!selected) {
        const complete = ids.every((id) => { const state = this.backend.getState(id); return state && state.nextDay < state.startDay; });
        return progress(complete ? "complete" : "waiting", complete ? "Selected API history saved" : "Waiting for selected accounts to load");
      }
      day = selected.nextDay;
      const next = this.backend.nextPullAt();
      if (this.now() < next) return progress("waiting", `Next API day in ${Math.ceil((next - this.now()) / 60_000)}m`);
      this.backend.setNextPullAt(this.now() + Math.max(60_000, this.options.intervalMs ?? 600_000));
      onProgress?.(progress("importing", "Pulling one day via API"));
      const events = await this.backend.fetchDay(current || undefined, day, signal);
      signal.throwIfAborted();
      this.backend.commit(current, day, events, { ...selected, nextDay: shiftDay(day, -1) });
      this.cursor = (ids.indexOf(current) + 1) % ids.length;
      this.retryAt = 0;
      this.failures = 0;
      const saved = progress("importing", `Saved ${events.length} API events`);
      return { ...saved, ...(this.options.endDay && saved.completed === saved.total ? { phase: "complete" as const, message: "Selected window saved" } : {}), changed: true };
    } catch (reason) {
      signal.throwIfAborted();
      this.cursor = (ids.indexOf(current) + 1) % ids.length;
      this.failures++;
      this.retryAt = this.now() + Math.min(600_000, 30_000 * 2 ** Math.min(this.failures - 1, 5));
      return progress("retrying", reason instanceof Error ? reason.message : String(reason));
    }
  }
}
