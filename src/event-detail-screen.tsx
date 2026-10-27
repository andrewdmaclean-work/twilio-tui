import { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { fetchCallDiagnostics, fetchCallExchanges, fetchEventDetail } from "./data";
import type { ActivityEvent, TimeZoneMode } from "./aggregate";
import { eventFailure, type CallDiagnostic, type DetailMode, type EventDetail, type WebhookExchange } from "./event-detail";
import { Tab, clipText } from "./components";
import { theme } from "./theme";

export function EventDetailScreen({ event, width, timeZone, onClose, loadDetail = fetchEventDetail, loadExchanges = fetchCallExchanges, loadDiagnostics = fetchCallDiagnostics }: {
  event: ActivityEvent; width: number; timeZone: TimeZoneMode; onClose: () => void;
  loadDetail?: typeof fetchEventDetail;
  loadExchanges?: typeof fetchCallExchanges;
  loadDiagnostics?: typeof fetchCallDiagnostics;
}) {
  const [mode, setMode] = useState<DetailMode>("detail");
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [exchanges, setExchanges] = useState<WebhookExchange[] | null>(null);
  const [diagnostics, setDiagnostics] = useState<CallDiagnostic[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    if (mode === "detail") setDetail(null); else if (mode === "webhooks") setExchanges(null); else setDiagnostics(null);
    const request = mode === "detail" ? loadDetail(event, controller.signal).then((value) => { if (!controller.signal.aborted) setDetail(value); })
      : mode === "webhooks" ? loadExchanges(event, controller.signal).then((value) => { if (!controller.signal.aborted) setExchanges(value); })
      : loadDiagnostics(event, controller.signal).then((value) => { if (!controller.signal.aborted) setDiagnostics(value); });
    void request.catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [event, mode, refresh, loadDetail, loadExchanges, loadDiagnostics]);
  useKeyboard((key) => {
    if (key.name === "escape") onClose();
    else if (key.name === "r") setRefresh((value) => value + 1);
  });
  const stamp = (value: string) => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return value;
    return timeZone === "utc" ? `${date.toISOString().replace("T", " ").slice(0, 19)} UTC` : date.toLocaleString();
  };
  return <box width="100%" height="100%" padding={1} backgroundColor={theme.background} flexDirection="column">
    <box height={1} flexDirection="row" justifyContent="space-between">
      <text fg={theme.cyan}><strong>{event.kind === "message" ? "MESSAGE DETAILS" : "CALL DETAILS"} · READ ONLY</strong></text>
      <Tab label="Esc Activity" active={false} onClick={onClose} />
    </box>
    <text fg={theme.muted} wrapMode="none">{clipText(`${event.profile ?? "Active CLI account"} · ${event.sid} · ${event.from} → ${event.to}`, width - 2)}</text>
    <box height={1} flexDirection="row" marginY={1}>
      <Tab label="Details" active={mode === "detail"} onClick={() => setMode("detail")} />
      {event.kind === "call" && <Tab label="Webhook exchanges" active={mode === "webhooks"} onClick={() => setMode("webhooks")} />}
      {event.kind === "call" && <Tab label="Errors & warnings" active={mode === "diagnostics"} onClick={() => setMode("diagnostics")} />}
      <Tab label="R Reload" active={false} onClick={() => setRefresh((value) => value + 1)} />
    </box>
    {mode === "webhooks" && <text fg={theme.muted}>Twilio makes call events available about 15 minutes after the call ends.</text>}
    {loading && <text fg={theme.amber}>Reading {mode === "webhooks" ? "webhook exchanges" : mode === "diagnostics" ? "errors and warnings" : "record"} from Twilio…</text>}
    {error && <text fg={theme.red}>Unable to read this record: {error}</text>}
    <scrollbox key={`${mode}:${refresh}`} focused flexGrow={1}>
      {mode === "detail" && detail && <box flexDirection="column">
        {eventFailure(detail) && <text fg={theme.red} wrapMode="word"><strong>{eventFailure(detail)}</strong></text>}
        {event.kind === "message" && <>
          <text fg={theme.cyan}><strong>MESSAGE TEXT</strong></text>
          <text fg={theme.ink} wrapMode="word">{detail.body || "Message text is empty or unavailable from Twilio."}</text>
          <text> </text>
        </>}
        {detail.fields.map(([label, value]) => <text key={label} fg={theme.ink} wrapMode="word">
          <span fg={theme.muted}>{label}: </span>{["Created", "Updated", "Sent", "Started", "Ended"].includes(label) ? stamp(value) : value}
        </text>)}
      </box>}
      {mode === "webhooks" && exchanges?.map((exchange, index) => <box key={index} flexDirection="column" marginBottom={1}>
        <text fg={theme.cyan} wrapMode="word"><strong>{index + 1}. {exchange.method || "REQUEST"} {exchange.url}</strong></text>
        <text fg={Number(exchange.status) >= 400 ? theme.red : theme.muted} wrapMode="word">{stamp(exchange.time)} · HTTP {exchange.status || "unknown"}{exchange.duration ? ` · ${exchange.duration} ms` : ""}{exchange.contentType ? ` · ${exchange.contentType}` : ""}</text>
        <text fg={theme.violet}>REQUEST PARAMETERS</text>
        <text fg={theme.ink} wrapMode="word">{exchange.parameters}</text>
        <text fg={theme.violet}>RESPONSE / TWIML</text>
        <text fg={theme.ink} wrapMode="word">{exchange.body || "Empty response body."}</text>
      </box>)}
      {mode === "webhooks" && exchanges?.length === 0 && <text fg={theme.muted}>No webhook exchanges returned. Recent calls may need more time; older records may no longer be available.</text>}
      {mode === "diagnostics" && diagnostics?.map((diagnostic, index) => <box key={index} flexDirection="column" marginBottom={1}>
        <text fg={diagnostic.level === "ERROR" ? theme.red : theme.amber} wrapMode="word"><strong>{diagnostic.level}{diagnostic.code ? ` ${diagnostic.code}` : ""} · {stamp(diagnostic.time)}</strong></text>
        <text fg={theme.ink} wrapMode="word">{diagnostic.message || "No explanation returned by Twilio."}</text>
        {diagnostic.url && <text fg={theme.muted} wrapMode="word">{diagnostic.method} {diagnostic.url}</text>}
      </box>)}
      {mode === "diagnostics" && diagnostics?.length === 0 && <text fg={theme.muted}>Twilio returned no errors or warnings for this call. Older diagnostics may no longer be available.</text>}
    </scrollbox>
    <text fg={theme.dim} wrapMode="none">{clipText("↑↓ / mouse wheel scroll · R reload · Esc activity · Details stay in memory only", width - 2)}</text>
  </box>;
}
