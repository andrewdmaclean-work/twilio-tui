import { expect, test } from "bun:test";
import type { ActivityEvent } from "./aggregate";
import { detailCommand, eventFailure, parseCallDiagnostics, parseEventDetail, parseWebhookExchanges } from "./event-detail";

const event: ActivityEvent = { sid: `SM${"a".repeat(32)}`, kind: "message", direction: "in", time: 0,
  from: "+15551110000", to: "+15552220000", profile: "prod", lineKey: "line" };

test("detail requests are scoped to the selected profile and contain only read commands", () => {
  expect(detailCommand(event)).toEqual(["api:core:messages:fetch", "--sid", event.sid, "-o", "json", "-l", "error", "-p", "prod"]);
  const call = { ...event, kind: "call" as const, sid: `CA${"b".repeat(32)}` };
  expect(detailCommand(call, "webhooks")).toContain("api:core:calls:events:list");
  expect(detailCommand(call, "diagnostics")).toContain("api:core:calls:notifications:list");
  expect(detailCommand(call, "webhooks")).toContain("--no-limit");
  expect(() => detailCommand(event, "webhooks")).toThrow();
  expect(() => detailCommand({ ...event, sid: "--bad" })).toThrow("SID");
});

test("message details preserve multiline text and delivery errors, and reject a different record", () => {
  const detail = parseEventDetail([{ sid: event.sid, body: "Hello\nWorld\u001b", status: "undelivered", error_code: 30003,
    error_message: "Unreachable destination", num_segments: 0 }], event);
  expect(detail.body).toBe("Hello\nWorld");
  expect(detail.fields).toContainEqual(["Segments", "0"]);
  expect(eventFailure(detail)).toBe("undelivered · Error 30003 · Unreachable destination");
  expect(() => parseEventDetail({ sid: "different" }, event)).toThrow("selected record");
  expect(eventFailure(parseEventDetail({ sid: event.sid, status: "delivered", errorCode: null }, event))).toBeNull();
});

test("webhook exchanges preserve request parameters, TwiML, HTTP failures and timing", () => {
  const exchanges = parseWebhookExchanges({ events: [{ request: { method: "POST", url: "https://example.test/voice", parameters: { call_sid: "CAfixture" } },
    response: { response_code: 500, date_created: "2026-10-27T10:00:00Z", request_duration: 125,
      content_type: "application/xml", response_body: "<Response><Say>Hello</Say></Response>" } }] });
  expect(exchanges[0]).toMatchObject({ method: "POST", status: "500", duration: "125", body: "<Response><Say>Hello</Say></Response>" });
  expect(exchanges[0]?.parameters).toContain("call_sid");
  expect(parseWebhookExchanges([{ events: [] }])).toEqual([]);
});

test("call diagnostics distinguish warnings and errors and decode Twilio explanations", () => {
  const rows = parseCallDiagnostics([{ log: "0", error_code: "11200", message_text: "msg=HTTP+retrieval+failure&ErrorCode=11200", request_url: "https://example.test/voice" },
    { log: "1", errorCode: "13332", messageText: "Warning text" }]);
  expect(rows[0]).toMatchObject({ level: "ERROR", code: "11200", message: "HTTP retrieval failure" });
  expect(rows[1]).toMatchObject({ level: "WARNING", message: "Warning text" });
});
