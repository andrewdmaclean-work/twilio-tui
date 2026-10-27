import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { Panel, Tab, clipText, mouseScrollStep } from "./components";
import type { SavedView } from "./views";
import { theme } from "./theme";

export function SavedViewsScreen({ views, width, height, onSave, onLoad, onRemove, onClose }: {
  views: SavedView[]; width: number; height: number;
  onSave: (name: string) => string | null;
  onLoad: (view: SavedView) => void;
  onRemove: (name: string) => void;
  onClose: () => void;
}) {
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const index = Math.max(0, Math.min(cursor, views.length - 1));
  const selected = views[index];
  const visible = Math.max(1, height - 14);
  const first = Math.max(0, Math.min(index - Math.floor(visible / 2), views.length - visible));
  const move = (step: number) => { setEditing(false); setCursor(Math.max(0, Math.min(views.length - 1, index + step))); };
  const save = () => {
    const error = onSave(name);
    setMessage(error ?? `Saved “${name.trim()}”.`);
    if (!error) { setName(""); setEditing(false); }
  };
  useKeyboard((key) => {
    if (key.name === "escape") { if (editing) setEditing(false); else onClose(); }
    else if (key.name === "tab") setEditing((value) => !value);
    else if (!editing) {
      if (key.name === "up" || key.name === "k") move(-1);
      else if (key.name === "down" || key.name === "j") move(1);
      else if ((key.name === "return" || key.name === "enter") && selected) onLoad(selected);
      else if (key.name === "n") setEditing(true);
      else if (key.name === "backspace" && selected) onRemove(selected.name);
    }
  });
  return <box width="100%" height="100%" backgroundColor={theme.background} padding={1} flexDirection="column">
    <box height={1} flexDirection="row" justifyContent="space-between">
      <text fg={theme.cyan}><strong>SAVED VIEWS</strong></text>
      <Tab label="Done" active={false} onClick={onClose} />
    </box>
    <text fg={theme.muted}>Restore accounts, filters, dates, chart settings, and the selected line.</text>
    <box height={1} flexDirection="row" marginY={1}>
      {selected && <>
        <Tab label="Load selected" active onClick={() => onLoad(selected)} />
        <Tab label="Remove selected" active={false} onClick={() => onRemove(selected.name)} />
      </>}
      <Tab label="N Name this view" active={false} onClick={() => setEditing(true)} />
    </box>
    <Panel title={`${views.length} SAVED VIEWS · click to select`} onMouseScroll={(event) => move(mouseScrollStep(event))}>
      {views.slice(first, first + visible).map((view, offset) => <box key={view.name} height={1}
        backgroundColor={index === first + offset ? theme.selection : undefined}
        onMouseDown={() => { setCursor(first + offset); setEditing(false); }}>
        <text fg={index === first + offset ? theme.cyan : theme.ink} wrapMode="none">{clipText(
          `${index === first + offset ? "›" : " "} ${view.name} · ${view.calendarPreset?.toUpperCase() ?? `${view.period}D`}${view.endDay && !view.calendarPreset ? ` to ${view.endDay}` : ""} · ${view.focus ?? (view.profiles.length ? `${view.profiles.length} account(s)` : "active CLI")} · ${view.unique ? "unique" : "events"}`, width - 6)}</text>
      </box>)}
      {!views.length && <text fg={theme.muted}>No saved views yet. Name the current dashboard below.</text>}
      <box flexGrow={1} />
      <text fg={theme.dim} wrapMode="none">{clipText(selected ? `${selected.line?.name ?? selected.line?.number ?? "All lines"} · ${selected.filter || "no line filter"} · ${selected.timeZone.toUpperCase()}` : "MTD, QTD, and rolling windows stay relative to today.", width - 6)}</text>
    </Panel>
    <text fg={theme.muted}>Save the current dashboard. An existing name updates that view.</text>
    <input value={name} placeholder="View name" maxLength={80} focused={editing}
      onMouseDown={() => setEditing(true)} onInput={setName} onSubmit={save} />
    <box height={1} flexDirection="row"><Tab label="Save / update view" active onClick={save} /></box>
    <text height={1} fg={theme.amber} wrapMode="none">{clipText(message, width - 2)}</text>
    <text fg={theme.muted}>↑↓ select · Enter load · N name · Tab switch · Backspace remove · Esc back</text>
  </box>;
}
