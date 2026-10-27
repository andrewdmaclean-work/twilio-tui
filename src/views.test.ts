import { expect, test } from "bun:test";
import { parseSavedViews, saveNamedView, type SavedView } from "./views";

const campaignView: SavedView = {
  name: "Campaign MTD", profiles: ["prod", "marketing"], focus: "prod", filter: "campaign, -test", excluded: ["+15551110000"],
  period: 27, endDay: null, calendarPreset: "mtd", timeZone: "local", direction: "in", chartType: "bars", chartInterval: "weekly",
  cumulative: true, chartVisible: false, unique: true,
  line: { key: "prod\u0000+15552220000", number: "+15552220000", name: "Campaign", profile: "prod" },
};

test("named views round-trip through JSON and preserve relative dates and campaign settings", () => {
  const saved = saveNamedView([], campaignView);
  expect(parseSavedViews(JSON.parse(JSON.stringify(saved)))).toEqual([campaignView]);
  expect(parseSavedViews([{ ...campaignView, calendarPreset: null, endDay: "2026-10-01" }])[0]?.endDay).toBe("2026-10-01");
  expect(parseSavedViews([{ ...campaignView, calendarPreset: null }])[0]?.endDay).toBeNull();
});

test("names update without duplicates, while malformed saved entries are ignored", () => {
  const original = [campaignView];
  const updated = saveNamedView(original, { ...campaignView, name: " campaign mtd ", chartVisible: true });
  expect(updated).toHaveLength(1);
  expect(updated[0]?.chartVisible).toBe(true);
  expect(original[0]?.chartVisible).toBe(false);
  expect(() => saveNamedView([], { ...campaignView, name: " " })).toThrow("name");
  expect(parseSavedViews([null, { ...campaignView, period: -1 }, { ...campaignView, endDay: "2026-02-30" },
    { ...campaignView, profiles: [123] }, { ...campaignView, chartType: "invalid" }, campaignView, campaignView])).toEqual([campaignView]);
  expect(parseSavedViews(undefined)).toEqual([]);
});
