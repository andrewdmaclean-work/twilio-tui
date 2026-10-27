import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { calendarWindow, dateWindow, shiftDay, dayKey, type ActivityEvent, type CalendarPreset, type DirectionMode, type TimeZoneMode } from "./aggregate";
import { accountDownloadStatus, type downloadWindowPlan, type HistorySettings } from "./data";
import type { ImportProgress } from "./backfill";
import { apiHistoryBoundary } from "./api-backfill";
import { Panel, Tab, clipText, formatNumber, mouseScrollStep } from "./components";
import { theme } from "./theme";

export const windowPresets = [1, 7, 30, 90, 180, 365, 730];

export type MenuAction = { label: string; shortcut: string; description: string; run: () => void };

export function ActionsScreen({ actions, width, height, onClose }: {
  actions: MenuAction[]; width: number; height: number; onClose: () => void;
}) {
  const [cursor, setCursor] = useState(0);
  const move = (step: number) => setCursor((value) => Math.max(0, Math.min(actions.length - 1, value + step)));
  const visible = Math.max(1, height - 9);
  const first = Math.max(0, Math.min(cursor - Math.floor(visible / 2), actions.length - visible));
  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "space") onClose();
    else if (key.name === "up" || key.name === "k") setCursor((value) => Math.max(0, value - 1));
    else if (key.name === "down" || key.name === "j") setCursor((value) => Math.min(actions.length - 1, value + 1));
    else if (key.name === "enter" || key.name === "return") actions[cursor]?.run();
  });
  return (
    <box width="100%" height="100%" backgroundColor={theme.background} padding={1} flexDirection="column">
      <box height={1} flexDirection="row" justifyContent="space-between">
        <text fg={theme.cyan}><strong>ACTIONS</strong></text>
        <Tab label="Esc BACK" active={false} onClick={onClose} />
      </box>
      <text fg={theme.muted}>Choose an action with arrows and Return, or click it.</text>
      <Panel title="DASHBOARD ACTIONS · shortcuts are optional" onMouseScroll={(event) => move(mouseScrollStep(event))}>
        {actions.slice(first, first + visible).map((action, offset) => (
          <box key={action.label} height={1} flexDirection="row" justifyContent="space-between"
            backgroundColor={cursor === first + offset ? theme.selection : undefined} onMouseDown={action.run}>
            <text fg={cursor === first + offset ? theme.cyan : theme.ink} wrapMode="none">{clipText(`${cursor === first + offset ? "›" : " "} ${action.label}`, width - 20)}</text>
            <text fg={theme.dim} wrapMode="none">{action.shortcut}</text>
          </box>
        ))}
        <box flexGrow={1} />
        <box height={1} flexDirection="row" justifyContent="space-between">
          <text fg={theme.dim}>{cursor + 1} / {actions.length} actions · ↑↓ scroll for more</text>
          <box flexDirection="row"><Tab label="↑ Previous" active={false} onClick={() => move(-1)} /><Tab label="↓ Next" active={false} onClick={() => move(1)} /></box>
        </box>
      </Panel>
      <text fg={theme.ink} wrapMode="none">{clipText(actions[cursor]?.description ?? "", width - 2)}</text>
      <text fg={theme.muted}>↑↓ choose · Return open · Esc back · Space closes menu</text>
    </box>
  );
}

export function WindowScreen({ start, end, timeZone, preset = null, onApply, onClose }: {
  start: string; end: string; timeZone: TimeZoneMode;
  preset?: CalendarPreset | null;
  onApply: (period: number, end: string, preset?: CalendarPreset | null) => void; onClose: () => void;
}) {
  const [draftStart, setStart] = useState(start);
  const [draftEnd, setEnd] = useState(end);
  const [draftPreset, setPreset] = useState(preset);
  const calendarRange = draftPreset ? calendarWindow(draftPreset, timeZone) : null;
  const selectedPreset = calendarRange?.start === draftStart && calendarRange?.end === draftEnd ? draftPreset : null;
  const [field, setField] = useState(0);
  const [error, setError] = useState("");
  const apply = () => {
    try {
      const next = dateWindow(draftStart, draftEnd);
      if (next.end > dayKey(new Date(), timeZone)) throw new Error("The end date must be today or earlier");
      onApply(next.period, next.end, selectedPreset);
    } catch (reason) { setError((reason as Error).message); }
  };
  useKeyboard((key) => {
    if (key.name === "tab") setField((value) => 1 - value);
    if (key.name === "escape") onClose();
  });
  return (
    <box width="100%" height="100%" backgroundColor={theme.background} padding={1} flexDirection="column">
      <box height={1} flexDirection="row" justifyContent="space-between">
        <text fg={theme.cyan}><strong>TIME WINDOW</strong></text>
        <Tab label="Esc CANCEL" active={false} onClick={onClose} />
      </box>
      <text fg={theme.muted}>Inclusive dates in {timeZone.toUpperCase()}. The same window applies to messages, calls, totals, and activity.</text>
      <box height={1} marginY={1} flexDirection="row" gap={1}>
        {windowPresets.map((days) => <Tab key={days} label={days === 1 ? "TODAY" : `${days}D`} active={false} onClick={() => {
          const today = dayKey(new Date(), timeZone);
          setStart(shiftDay(today, -(days - 1))); setEnd(today); setPreset(null); setError("");
        }} />)}
      </box>
      <box height={1} flexDirection="row" gap={1} marginBottom={1}>
        {(["mtd", "qtd"] as const).map((value) => <Tab key={value}
          label={value === "mtd" ? "MTD · Month to date" : "QTD · Quarter to date"} active={selectedPreset === value} onClick={() => {
            const next = calendarWindow(value, timeZone);
            setStart(next.start); setEnd(next.end); setPreset(value); setError("");
          }} />)}
      </box>
      <box border borderColor={theme.border} padding={1} flexDirection="column" gap={1}>
        <text fg={theme.muted}>Start date (YYYY-MM-DD)</text>
        <input value={draftStart} focused={field === 0} onMouseDown={() => setField(0)} onInput={setStart} onSubmit={apply} />
        <text fg={theme.muted}>End date (YYYY-MM-DD)</text>
        <input value={draftEnd} focused={field === 1} onMouseDown={() => setField(1)} onInput={setEnd} onSubmit={apply} />
        <box flexDirection="row"><Tab label="APPLY WINDOW" active onClick={apply} /></box>
        {error && <text fg={theme.red}>{error}</text>}
      </box>
      <text fg={theme.muted}>Tab switch dates · Enter apply · Esc cancel</text>
      <text fg={theme.muted}>On the dashboard: - older window · = newer window · H today.</text>
    </box>
  );
}

export function DownloadsScreen({ accounts, selected, cursor, paused, options, progress, editing, notice, width, height, onToggle, onRun, onTarget, onPace, onClose, onApplyDate, onCancelDate, onScroll, preview = false, plan }: {
  accounts: string[]; selected: string[]; cursor: number; paused: boolean; options: HistorySettings;
  progress: ImportProgress | null; editing: string | null; notice: string | null; width: number; height: number;
  onToggle: (id: string) => void; onRun: () => void; onTarget: () => void; onPace: () => void;
  onClose?: () => void;
  onApplyDate?: () => void;
  onCancelDate?: () => void;
  onScroll?: (step: number) => void;
  preview?: boolean; plan?: ReturnType<typeof downloadWindowPlan>;
}) {
  const retention = apiHistoryBoundary(Date.now());
  const target = options.startDay && options.startDay > retention ? options.startDay : retention;
  const extraRows = Number(!!options.startDay && options.startDay < retention) + Number(editing !== null) + Number(!!notice) + Number(!!plan);
  const visible = Math.max(1, height - 16 - extraRows);
  const first = Math.max(0, Math.min(cursor - Math.floor(visible / 2), accounts.length - visible));
  const room = Math.max(10, width - 6);
  return (
    <box width="100%" height="100%" backgroundColor={theme.background} padding={1} flexDirection="column">
      <box height={1} flexDirection="row" justifyContent="space-between">
        <text fg={theme.cyan}><strong>{preview ? "DOWNLOAD WINDOW · PREVIEW" : "HISTORY DOWNLOADS"}</strong></text>
        <Tab label={preview ? "Esc CANCEL" : "Esc BACK"} active={false} onClick={onClose ?? (() => {})} />
      </box>
      <text fg={theme.muted} wrapMode="none">Older messages and calls, downloaded one complete UTC day at a time.</text>
      <box height={1} flexDirection="row" gap={1} marginY={1}>
        {editing !== null ? <>
          <Tab label="Apply date" active onClick={() => onApplyDate?.()} />
          <Tab label="Cancel date" active={false} onClick={() => onCancelDate?.()} />
        </> : <>
        <Tab label={paused ? "S START / RESUME" : "S PAUSE"} active={!paused} onClick={onRun} />
        <Tab label="G OLDEST DATE" active={false} onClick={onTarget} />
        <Tab label={`I PACE: ${options.intervalMinutes ?? 10} MIN`} active={false} onClick={onPace} />
        </>}
      </box>
      <text fg={theme.ink} wrapMode="none">{preview ? "PREVIEW" : paused ? "PAUSED" : "RUNNING"} · {options.endDay ? `${options.startDay} → ${options.endDay} UTC` : `oldest date: ${target}`} · {selected.length} account(s) selected</text>
      {options.startDay && options.startDay < retention && <text fg={theme.amber}>Requested {options.startDay}; API downloads stop at {retention}.</text>}
      <text fg={theme.muted} wrapMode="none">{preview ? "S starts this plan. Esc cancels the preview. Existing downloads keep their settings." : options.endDay ? "Downloads fill only missing UTC days in this window; saved days are skipped." : "Recent sync covers 60 days. Older downloads extend each saved range backwards."}</text>
      <text fg={theme.muted} wrapMode="none">{plan ? `${plan.days} missing account-days · ~${Math.floor(plan.minutes / 60)}h ${Math.ceil(plan.minutes % 60)}m pacing + transfer time` : `API history starts ${retention}; earlier saved data remains viewable.`}</text>
      {plan && <text fg={theme.amber} wrapMode="none">{plan.unavailable} days outside API history · {plan.open} open day(s) use recent sync · older saved data stays</text>}
      <text fg={progress?.phase === "retrying" ? theme.amber : theme.cyan} wrapMode="none">{clipText(progress ? `${progress.phase.toUpperCase()} · ${progress.message} · ${progress.profile ?? ""} ${progress.day ?? ""}${progress.elapsedSeconds ? ` · ${progress.elapsedSeconds}s` : ""} · ${progress.completed}/${progress.total} days` : "Choose accounts and an oldest date, then start.", room)}</text>
      {editing !== null && <text fg={theme.cyan}>Oldest date: {editing}▏ · YYYY-MM-DD · Enter apply · Esc cancel</text>}
      {notice && <text fg={theme.amber}>{notice}</text>}
      <Panel title="ACCOUNTS · click or Space to toggle" onMouseScroll={(event) => onScroll?.(mouseScrollStep(event))}>
        {accounts.slice(first, first + visible).map((id, index) => {
          const status = accountDownloadStatus(id);
          const active = first + index === cursor;
          const needed = plan?.accounts.find((account) => account.id === id);
          return <box key={id} height={1} backgroundColor={active ? theme.selection : undefined} onMouseDown={() => onToggle(id)}>
            <text fg={active ? theme.cyan : theme.ink} wrapMode="none">{clipText(`${active ? "›" : " "} [${selected.includes(id) ? "✓" : " "}] ${(id || "Active CLI account").padEnd(24)}  ${needed ? `${needed.days.length} missing day(s)${needed.days.length ? ` · ${needed.days[0]} → ${needed.days.at(-1)}` : ""}` : status.from ? `${status.from} → ${status.through ?? "today"}` : options.endDay ? "Select to check this window" : "Load recent traffic first"}${!plan && status.from ? ` · next: ${shiftDay(status.from, -1) < target ? "target reached" : shiftDay(status.from, -1)}` : ""}`, room)}</text>
          </box>;
        })}
        <box flexGrow={1} />
        <text fg={theme.dim} wrapMode="none">Pause keeps saved days. Resume continues from the last completed day.</text>
      </Panel>
      <text fg={theme.muted} wrapMode="none">↑↓ select · Space toggle · S start/pause · G date · I pace · Esc/B back</text>
    </box>
  );
}

export function ActivityTable({ events, direction, timeZone, width, height, cursor, kind, onKind, onSelect, onScroll, range, onClearRange, onShowLines, onOpen }: {
  events: ActivityEvent[]; direction: DirectionMode; timeZone: TimeZoneMode; width: number; height: number;
  cursor: number; kind: "all" | "message" | "call"; onKind: (kind: "all" | "message" | "call") => void;
  onSelect?: (index: number) => void;
  onScroll?: (step: number) => void;
  range?: { from: string; through: string } | null;
  onClearRange?: () => void;
  onShowLines?: () => void;
  onOpen?: (event: ActivityEvent) => void;
}) {
  const visible = Math.max(1, height - 6);
  const index = Math.min(Math.max(0, events.length - 1), cursor);
  const first = Math.max(0, Math.min(index - Math.floor(visible / 2), events.length - visible));
  const selected = events[index];
  const counts = { messages: events.filter((event) => event.kind === "message").length, calls: events.filter((event) => event.kind === "call").length };
  const room = Math.max(10, width - 4);
  const stamp = (time: number) => {
    const date = new Date(time);
    return `${dayKey(date, timeZone)} ${timeZone === "utc" ? date.toISOString().slice(11, 19) : date.toTimeString().slice(0, 8)}`;
  };
  return (
    <Panel title={`ACTIVITY · ${formatNumber(events.length)} events · ${range ? `${range.from} → ${range.through} · ` : ""}${timeZone.toUpperCase()}`} width={width} height={height} onMouseScroll={(event) => onScroll?.(mouseScrollStep(event))}>
      <box height={1} flexDirection="row" gap={1}>
        {(["all", "message", "call"] as const).map((value) => <Tab key={value} label={value === "all" ? "ALL" : value === "message" ? "MESSAGES" : "CALLS"} active={kind === value} onClick={() => onKind(value)} />)}
        {range && <Tab label="Full window" active={false} onClick={() => onClearRange?.()} />}
        <Tab label="V lines" active={false} onClick={() => onShowLines?.()} />
        {selected && onOpen && <Tab label="Open details" active={false} onClick={() => onOpen(selected)} />}
      </box>
      <text fg={theme.muted} wrapMode="none">{clipText("TIME                 TYPE   DIR FROM                 TO                   ACCOUNT", room)}</text>
      {events.slice(first, first + visible).map((event, offset) => <box key={`${event.profile ?? ""}:${event.sid}`} height={1} backgroundColor={first + offset === index ? theme.selection : undefined} onMouseDown={() => onSelect?.(first + offset)}>
        <text fg={event.kind === "message" ? theme.cyan : theme.violet} wrapMode="none">{clipText(`${stamp(event.time)}  ${event.kind === "message" ? "MSG " : "CALL"}   ${event.direction.padEnd(3)} ${clipText(event.from, 20).padEnd(20)} ${clipText(event.to, 20).padEnd(20)} ${event.profile ?? "active"}`, room)}</text>
      </box>)}
      {!events.length && <text fg={theme.muted}>No matching events in the saved part of this window.</text>}
      <box flexGrow={1} />
      <text fg={theme.muted} wrapMode="none">{clipText(selected ? `${stamp(selected.time)} · ${selected.profile ?? "active"} · ${selected.sid} · ${selected.from} → ${selected.to}` : "", room)}</text>
      <text fg={theme.dim} wrapMode="none">{clipText(`${events.length ? `${first + 1}–${Math.min(first + visible, events.length)} of ${events.length} · ` : ""}${formatNumber(counts.messages)} messages · ${formatNumber(counts.calls)} calls · ↑↓ scroll${onOpen ? " · Enter details" : ` · direction ${direction}`}`, room)}</text>
    </Panel>
  );
}
