import { shiftDay } from "./aggregate";
import type { TrafficEvent } from "./aggregate";

export class ExportJobFailed extends Error {}

export type ExportStatus = { ready: boolean; emptyDays: string[] };

export type ExportKind = "Messages" | "Calls";
export type ImportState = {
  startDay: string;
  initialDay: string;
  nextDay: string;
  batch?: { from: string; through: string };
  jobs: Partial<Record<ExportKind, { sid: string; createdAt: number; ready?: boolean; emptyDays?: string[] }>>;
};
export type ImportProgress = {
  phase: "starting" | "importing" | "waiting" | "retrying" | "complete";
  profile?: string;
  day?: string;
  completed: number;
  total: number;
  message: string;
  changed?: boolean;
  elapsedSeconds?: number;
};
export type ImportBackend = {
  getState(id: string): ImportState | null;
  saveState(id: string, state: ImportState): void;
  coverage(id: string): string | null;
  accountStart(profile: string | undefined, signal: AbortSignal): Promise<string>;
  createJob(profile: string | undefined, from: string, through: string, kind: ExportKind, signal: AbortSignal): Promise<string>;
  jobReady(profile: string | undefined, sid: string, signal: AbortSignal): Promise<boolean | ExportStatus>;
  download(profile: string | undefined, day: string, kind: ExportKind, signal: AbortSignal): Promise<TrafficEvent[]>;
  commit(id: string, day: string, events: TrafficEvent[], state: ImportState): void;
  getSchedule(): { nextBatchAt: number; nextDownloadAt?: number; budgetDay: string; submitted: number } | null;
  saveSchedule(value: { nextBatchAt: number; nextDownloadAt?: number; budgetDay: string; submitted: number }): void;
};

const dayCount = (from: string, to: string) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1);

/** One serial worker shared by all selected accounts. Timers belong to the caller. */
export class HistoryImporter {
  private cursor = 0;
  private failures = 0;
  private retryAt = 0;
  constructor(private backend: ImportBackend, private profiles: string[], private now = () => Date.now()) {}

  async step(signal: AbortSignal, onProgress?: (progress: ImportProgress) => void): Promise<ImportProgress> {
    signal.throwIfAborted();
    const ids = this.profiles.length ? this.profiles : [""];
    let current = ids[this.cursor % ids.length]!;
    let activeDay: string | undefined;
    const progress = (phase: ImportProgress["phase"], message: string): ImportProgress => {
      let completed = 0, total = 0;
      for (const id of ids) {
        const state = this.backend.getState(id);
        if (!state) continue;
        total += dayCount(state.startDay, state.initialDay);
        completed += dayCount(shiftDay(state.nextDay, 1), state.initialDay);
      }
      return { phase, profile: current || "active", day: activeDay, completed: Math.min(completed, total), total, message };
    };
    if (this.now() < this.retryAt) return progress("retrying", `Retry in ${Math.ceil((this.retryAt - this.now()) / 1000)}s`);
    try {
      let selected: ImportState | null = null;
      for (let offset = 0; offset < ids.length; offset++) {
        current = ids[(this.cursor + offset) % ids.length]!;
        let state = this.backend.getState(current);
        const coverage = this.backend.coverage(current);
        // Wait for the foreground pull so the archived range remains contiguous.
        if (!coverage) continue;
        if (!state) {
          onProgress?.(progress("starting", "Reading history start date"));
          const startDay = await this.backend.accountStart(current || undefined, signal);
          signal.throwIfAborted();
          const nextDay = shiftDay(coverage, -1);
          state = { startDay, initialDay: nextDay, nextDay, jobs: {} };
          this.backend.saveState(current, state);
        }
        if (state.nextDay >= coverage) {
          const nextDay = shiftDay(coverage, -1);
          state = state.batch && nextDay >= state.batch.from
            ? { ...state, nextDay }
            : { ...state, nextDay, batch: undefined, jobs: {} };
          this.backend.saveState(current, state);
        }
        if (state.nextDay >= state.startDay) { selected = state; break; }
      }
      if (!selected) {
        const finished = ids.every((id) => { const state = this.backend.getState(id); return state && state.nextDay < state.startDay; });
        return progress(finished ? "complete" : "waiting", finished ? "Available history imported" : "Waiting for selected accounts to finish loading");
      }
      activeDay = selected.nextDay;
      const today = new Date(this.now()).toISOString().slice(0, 10);
      const schedule = this.backend.getSchedule() ?? { nextBatchAt: 0, budgetDay: today, submitted: 0 };
      if (schedule.budgetDay !== today) { schedule.budgetDay = today; schedule.submitted = 0; }
      // Old checkpoints refer to one-day jobs; finish them without resubmitting.
      if (!selected.batch && Object.keys(selected.jobs).length) {
        selected.batch = { from: activeDay, through: activeDay };
        this.backend.saveState(current, selected);
      }
      if (!selected.batch) {
        if (this.now() < schedule.nextBatchAt) return progress("waiting", `Next export batch in ${Math.ceil((schedule.nextBatchAt - this.now()) / 60_000)}m`);
        const proposed = shiftDay(activeDay, -6);
        selected.batch = { from: proposed < selected.startDay ? selected.startDay : proposed, through: activeDay };
        this.backend.saveState(current, selected);
        schedule.nextBatchAt = this.now() + 600_000;
        this.backend.saveSchedule(schedule);
      }
      const batch = selected.batch;
      for (const kind of ["Messages", "Calls"] as const) {
        const job = selected.jobs[kind];
        // Twilio removes export jobs/files after seven days; renew expired jobs.
        if (job && this.now() - job.createdAt < 6 * 86_400_000) continue;
        const requestedDays = dayCount(batch.from, batch.through);
        if (schedule.submitted + requestedDays > 300) return progress("waiting", "Daily export budget reached; resumes next UTC day");
        schedule.submitted += requestedDays;
        this.backend.saveSchedule(schedule);
        onProgress?.(progress("importing", `Submitting ${kind} export`));
        const sid = await this.backend.createJob(current || undefined, batch.from, batch.through, kind, signal);
        // Keep a returned job ID even if pause was pressed as the request completed.
        selected.jobs[kind] = { sid, createdAt: this.now() };
        this.backend.saveState(current, selected);
        signal.throwIfAborted();
      }
      for (const kind of ["Messages", "Calls"] as const) {
        const job = selected.jobs[kind]!;
        if (job.ready && job.emptyDays !== undefined && this.now() - job.createdAt < 6 * 86_400_000) continue;
        try {
          onProgress?.(progress("importing", `Checking ${kind} export`));
          const result = await this.backend.jobReady(current || undefined, job.sid, signal);
          const status = typeof result === "boolean" ? { ready: result, emptyDays: [] } : result;
          if (!status.ready) return progress("importing", `Twilio is preparing ${kind} (${batch.from} to ${batch.through})`);
          job.ready = true;
          job.emptyDays = status.emptyDays;
          this.backend.saveState(current, selected);
        } catch (reason) {
          if (reason instanceof ExportJobFailed) {
            delete selected.jobs[kind];
            this.backend.saveState(current, selected);
          }
          throw reason;
        }
      }
      if (this.now() < (schedule.nextDownloadAt ?? 0)) return progress("waiting", `Next download in ${Math.ceil((schedule.nextDownloadAt! - this.now()) / 60_000)}m`);
      const events: TrafficEvent[] = [];
      for (const kind of ["Messages", "Calls"] as const) {
        if (selected.jobs[kind]?.emptyDays?.includes(activeDay)) continue;
        onProgress?.(progress("importing", `Downloading ${kind}`));
        const downloaded = await this.backend.download(current || undefined, activeDay, kind, signal);
        for (const event of downloaded) events.push(event);
      }
      signal.throwIfAborted();
      const nextDay = shiftDay(activeDay, -1);
      const batchFinished = nextDay < batch.from;
      // Pace downloaded days separately from preparing weekly export jobs.
      schedule.nextDownloadAt = this.now() + 600_000;
      this.backend.saveSchedule(schedule);
      this.backend.commit(current, activeDay, events, {
        ...selected, nextDay, batch: batchFinished ? undefined : batch,
        jobs: batchFinished ? {} : selected.jobs,
      });
      this.cursor = (ids.indexOf(current) + 1) % ids.length;
      this.failures = 0;
      this.retryAt = 0;
      return { ...progress("importing", `Saved ${events.length} events`), changed: true };
    } catch (reason) {
      signal.throwIfAborted();
      this.cursor = (ids.indexOf(current) + 1) % ids.length;
      this.failures++;
      this.retryAt = this.now() + Math.min(600_000, 30_000 * 2 ** Math.min(this.failures - 1, 5));
      return progress("retrying", reason instanceof Error ? reason.message : String(reason));
    }
  }
}
