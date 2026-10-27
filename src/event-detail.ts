import type { ActivityEvent } from "./aggregate";

export type EventDetail = { fields: Array<[string, string]>; body?: string };
export type WebhookExchange = { method: string; url: string; parameters: string; status: string; duration: string; time: string; contentType: string; body: string };
export type CallDiagnostic = { level: string; code: string; message: string; time: string; url: string; method: string };
export type DetailMode = "detail" | "webhooks" | "diagnostics";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Render remote content as plain text; never interpret terminal control sequences. */
export const plainText = (value: unknown): string => String(value ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
const field = (value: Record<string, unknown>, key: string): unknown => value[key] ?? value[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)];

export function parseEventDetail(value: unknown, event: ActivityEvent): EventDetail {
  const data = record(Array.isArray(value) ? value[0] : value);
  if (data.sid !== event.sid) throw new Error("Twilio did not return the selected record");
  const fields: Array<[string, string]> = [["SID", event.sid], ["Profile", event.profile || "Active CLI account"]];
  const keys: Array<[string, string]> = [
    ["status", "Status"], ["direction", "Direction"], ["from", "From"], ["to", "To"], ["accountSid", "Account SID"],
    ["dateCreated", "Created"], ["dateUpdated", "Updated"],
    ...(event.kind === "message" ? [
      ["dateSent", "Sent"], ["errorCode", "Error code"], ["errorMessage", "Error"],
      ["numSegments", "Segments"], ["numMedia", "Media items"], ["messagingServiceSid", "Messaging service"],
    ] : [
      ["startTime", "Started"], ["endTime", "Ended"], ["duration", "Duration (seconds)"],
      ["parentCallSid", "Parent call SID"], ["answeredBy", "Answered by"], ["forwardedFrom", "Forwarded from"],
    ]).map(([key, label]) => [key!, label!] as [string, string]),
    ["price", "Price"], ["priceUnit", "Currency"],
  ];
  for (const [key, label] of keys) {
    const value = field(data, key);
    if (value !== null && value !== undefined && value !== "") fields.push([label, plainText(value)]);
  }
  return { fields, ...(event.kind === "message" ? { body: plainText(data.body) } : {}) };
}

export function parseWebhookExchanges(value: unknown): WebhookExchange[] {
  const rows = Array.isArray(value) ? value : record(value).events;
  if (!Array.isArray(rows)) throw new Error("Twilio did not return call events");
  return rows.flatMap((entry): WebhookExchange[] => {
    const data = record(entry);
    if (Array.isArray(data.events)) return parseWebhookExchanges(data.events);
    if (!data.request && !data.response) return [];
    const request = record(data.request), response = record(data.response);
    return [{
      method: plainText(request.method), url: plainText(request.url),
      parameters: plainText(typeof request.parameters === "string" ? request.parameters : JSON.stringify(request.parameters ?? {}, null, 2)),
      status: plainText(field(response, "responseCode")), duration: plainText(field(response, "requestDuration")),
      time: plainText(field(response, "dateCreated")), contentType: plainText(field(response, "contentType")),
      body: plainText(field(response, "responseBody")),
    }];
  });
}

export function parseCallDiagnostics(value: unknown): CallDiagnostic[] {
  const rows = Array.isArray(value) ? value : record(value).notifications;
  if (!Array.isArray(rows)) throw new Error("Twilio did not return call diagnostics");
  return rows.map((entry) => {
    const data = record(entry);
    const raw = plainText(field(data, "messageText"));
    const parameters = new URLSearchParams(raw);
    const message = parameters.get("msg") ?? parameters.get("Msg") ?? raw;
    return { level: String(data.log) === "0" ? "ERROR" : String(data.log) === "1" ? "WARNING" : "NOTICE",
      code: plainText(field(data, "errorCode")), message: plainText(message),
      time: plainText(field(data, "messageDate") ?? field(data, "dateCreated")),
      url: plainText(field(data, "requestUrl")), method: plainText(field(data, "requestMethod")) };
  });
}

export function eventFailure(detail: EventDetail): string | null {
  const values = new Map(detail.fields);
  const code = values.get("Error code");
  const status = values.get("Status");
  if ((code && code !== "0") || values.get("Error") || status === "failed" || status === "undelivered") {
    return [status, code && code !== "0" ? `Error ${code}` : "", values.get("Error")].filter(Boolean).join(" · ");
  }
  return null;
}

export function detailCommand(event: ActivityEvent, mode: DetailMode = "detail"): string[] {
  const valid = event.kind === "call" ? /^CA[0-9a-f]{32}$/i : /^(SM|MM)[0-9a-f]{32}$/i;
  if (!valid.test(event.sid)) throw new Error("This saved record has no valid Twilio SID");
  if (mode !== "detail" && event.kind !== "call") throw new Error("Call diagnostics and exchanges are available for calls");
  const command = mode === "webhooks" ? "api:core:calls:events:list" : mode === "diagnostics" ? "api:core:calls:notifications:list"
    : event.kind === "call" ? "api:core:calls:fetch" : "api:core:messages:fetch";
  return [command,
    mode !== "detail" ? "--call-sid" : "--sid", event.sid, ...(mode !== "detail" ? ["--no-limit", "--page-size", "1000"] : []),
    "-o", "json", "-l", "error", ...(event.profile ? ["-p", event.profile] : [])];
}
