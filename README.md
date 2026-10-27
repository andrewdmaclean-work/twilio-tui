# Twilio-TUI

A keyboard driven terminal dashboard for SMS/MMS/WhatsApp messages and voice calls, incoming and outgoing, across one or more Twilio accounts selected through the Twilio CLI.

## Contents

- [Requirements](#requirements)
- [Run](#run)
- [First-use walkthrough](#first-use-walkthrough)
- [Accounts: one or all](#accounts-one-or-all)
- [Lines, names, and filtering](#lines-names-and-filtering)
- [Excluding numbers (test phones)](#excluding-numbers-test-phones)
- [Choosing accounts](#choosing-accounts)
- [Time windows and activity](#time-windows-and-activity)
- [Read-only message and call details](#read-only-message-and-call-details)
- [Saved views](#saved-views)
- [Dashboard](#dashboard)
- [Keyboard reference](#keyboard-reference)
- [CSV export](#csv-export)
- [Data](#data)
- [Saved data and history](#saved-data-and-history)
- [History downloads](#history-downloads)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Requirements

- Bun 1.3 or newer
- Twilio CLI installed and authenticated (`twilio login`)

Each selected account needs read access for the features you use:

| Feature | Required access |
| --- | --- |
| Dashboard and activity | List Messages and Calls; list Incoming Phone Numbers for owned lines and friendly names |
| Individual record details | Fetch the selected Message or Call |
| Call webhook exchanges and diagnostics | List the selected Call's Events and Notifications |
| History downloads | List Messages and Calls, and read the all-time total-usage summary used to find the account's history start |

The TUI uses read operations against Twilio. Settings, saved views, and downloaded history are stored locally.

## Run

```sh
bun install
bun start
```

Press `p` to choose which saved Twilio CLI profiles (accounts) to load. The selection is saved locally for the next launch. You can also set profiles at launch:

```sh
TWILIO_CLI_PROFILE=production bun start
TWILIO_CLI_PROFILES=production,staging bun start
```

The equivalent `--profile=production` and `--profiles=production,staging` options are also supported. With no profiles chosen, the active CLI profile is used.

## First-use walkthrough

After starting the app:

1. **Choose accounts.** Press `p`, use arrows and Space to select your Twilio CLI profiles, then press `d` to apply. Wait for the initial sync to finish.
2. **Find a campaign.** Press `/`, type part of its line name or phone number, and press Enter. The dashboard now totals the matching lines. For one line's campaign totals, select it with arrows and press Enter.
3. **Choose dates.** Press `w`, click **MTD · Month to date** (or QTD), then **Apply Window**. Incoming traffic is selected by default, so these totals count responses received.
4. **Choose what to count.** Press `n` for unique contacts, or keep event counts to include every text and call. In unique mode, someone contacting multiple matching lines counts once in the overall total.
5. **Inspect a response.** Press `v`, select a message or call with arrows, and press Enter. Read message text and delivery errors, or inspect a call's **Webhook exchanges** and **Errors & warnings** tabs. Esc returns to activity.
6. **Save this setup.** Press `s`, choose **Name this view**, enter a name such as `Campaign MTD`, and click **Save / update view**. Use `s` → **Load selected** to return to it later; MTD and QTD stay relative to today.

Space opens the Actions menu and `?` opens keyboard help. If the chart is shaded or counts have a `≥` marker, check the DATA row and see [Troubleshooting](#troubleshooting).

## Accounts: one or all

When more than one account is loaded, an account bar appears under the title:

```
ACCOUNT   ALL 3   primary   twld-prod   demo-sub
```

- `ALL` combines every loaded account; the line table gets an ACCOUNT column, and the same number on two accounts gets a row for each.
- Click an account, or press `Tab` / `Shift+Tab` (or `]` / `[`), to show **only that account**. The title then reads `account <name>`. `a` goes back to all.
- `p` changes which accounts are loaded in the first place (see [Choosing accounts](#choosing-accounts)).

With a single account loaded the bar is hidden. The account in view is remembered between launches.

## Lines, names, and filtering

Every phone number on the account is listed with its friendly name, including numbers with no traffic in the range. Lines are sorted by traffic, busiest first. A few rows have special labels:

- `—`: the number is on the account but has no friendly name set (Twilio's default of the formatted number is not shown as a name)
- `(not on account)`: traffic used a number that is no longer, or never was, an incoming phone number on the account (for example a released number)
- `(no number)`: traffic with no phone number, such as calls placed from a browser or SIP client

Press `/` to filter lines by name or number. The whole dashboard — totals, chart, and line table — then reflects only matching lines, and a FILTER bar shows how many lines are hidden.

- `guerilla` shows lines whose name contains "Guerilla" (doubled letters are ignored, so it also matches "Guerrilla"; case and punctuation are ignored too)
- `guerilla, support` shows lines matching either term
- `-dev` hides lines matching "dev"; combine with others, e.g. `guerilla, -test`
- `4155` matches by number

While typing, `Enter` applies, `Esc` cancels, and `Ctrl+U` clears. When you reopen the filter, the current text is highlighted and typing replaces it; press `→` or Backspace to edit it instead. `Ctrl+U` on the main view clears the filter without opening it.

The filter is saved, so if you only care about certain lines it applies every time you start.

## Excluding numbers (test phones)

Press `x` to exclude outside numbers, such as your own test phones. Messages and calls to or from an excluded number are left out of every total, chart, and line, in both directions. Your own lines still stay listed.

The exclusions screen lists every outside number that exchanged traffic with the current view (account and filter), busiest first, with its message and call counts in each direction, so test phones are easy to spot. Excluded numbers are pinned to the top so they are easy to undo.

- `↑` / `↓`: move · Space/Enter: exclude or un-exclude · Backspace: un-exclude
- `n`: type a number in any format (`555 010 0001`, `+15550100001`, `whatsapp:+1…` all match the same number), then Enter
- Esc or `x`: back to the dashboard

When a caller is excluded, calls they made that were forwarded on are excluded too. The FILTER bar on the dashboard shows how many numbers are excluded and how many events were left out. Exclusions are saved.

## Choosing accounts

Press `p` to manage accounts. The list combines Twilio CLI profiles, your saved selection, and accounts with local traffic. Profiles missing from the CLI are marked disconnected, so you can still remove them.

- `↑` / `↓`: move · Space/Enter: tick or untick · `a`: tick all · `c`: untick all (use the active CLI profile)
- `r`: reload the list from the Twilio CLI · `d`: done (apply and save) · Esc: cancel
- `f` (or Backspace / Mac Delete): forget the highlighted account, then `y` to confirm or `n` to cancel. This immediately removes its selection, saved traffic, and history checkpoint from this app. Twilio CLI credentials remain managed by the CLI. Unticking an account instead keeps its saved traffic. You can also click accounts, Save & Back, Forget Selected, and the confirmation buttons.

## Time windows and activity

Press `w` or click Dates… to choose exact inclusive start and end dates (`YYYY-MM-DD`), or a preset for today, 7, 30, 90, 180, 365, or 730 days. `Tab` switches date fields and Return applies. The compact dashboard shows 7, 30, and 90-day presets; wider terminals show all seven. `0`–`6` select any preset directly. The date bar always shows the actual window. Click Older / Newer or use `-` / `=` to move backwards or forwards by a whole window (`+` also moves newer). `,` / `.` move by a week, `<` / `>` by a calendar month, and `h` returns to today. PageUp / PageDown remain optional alternatives.

**MTD (month to date)** and **QTD (quarter to date)** are available in Dates; click one, then Apply Window. Terminals at least 140 columns wide also show direct MTD/QTD buttons. These ranges run from the first of the month or calendar quarter (January, April, July, October) through today in the selected UTC/local timezone, including today’s activity so far. The selection follows the calendar as dates and timezones change. Browsing older/newer leaves the calendar preset and keeps its current window length; selecting a numbered preset or editing dates also returns to a fixed window. Comparisons continue to use the immediately preceding window of equal length.

The DATA row shows how many days are complete, partial, or missing across the accounts in view. A day is complete only when every selected account has coverage for the entire day in the selected timezone. The current day stays partial until it closes and is synced. Today’s observed counts are plotted with a **SO FAR** label, including in the current week and cumulative charts. Tables mark these periods with `*`. Missing history and other partial coverage stay shaded `░` in charts; daily tables use `—` for missing values and `≥` for observed partial counts. Cumulative charts remain shaded after a gap because the running total is incomplete. Totals show `≥` while any part of the window is unknown, and percentage comparisons appear only when both windows are complete.

When missing history hides the entire chart, an explanation replaces the empty plot. Its buttons let you switch to period counts, preview a window download, choose dates, or inspect the available activity. Tables continue to show observed counts and coverage markers.

Press `u` or click DOWNLOAD WINDOW to preview downloads for the current dates and accounts. The preview selects accounts with missing history, lists missing account-days, and estimates the pacing time plus transfer time. Adjust accounts with Space and pacing with `i`; `s` starts the plan and Esc cancels it without changing the existing download settings. Window downloads fetch only missing, closed UTC days within the selected window. Local windows may require adjacent UTC days. Dates before API retention or account creation are identified as unavailable; the open UTC day continues to use recent sync.

The summary always shows totals for the full selected window. The chart starts in **Cumulative** mode: texts, calls, and combined events build up from the first selected day. In line mode, each has its own series; stacked bars show texts and calls adding up to total events. `c` or the chart's mode button switches between cumulative and period counts. `g` or **Hide chart / Show chart** hides or restores the visual, giving the number or activity list the available space. Summary totals stay visible, and changing dates, the selected number, or event-type filters still works while the chart is hidden. `c` also reopens the cumulative chart when hidden.

Click **I DAILY / I WEEKLY**, or press `i`, to group any chart style by day or week. Weeks run Monday–Sunday in the selected UTC or local time zone; the first and last week include only dates inside your window. Weekly counts show texts and calls in each week; cumulative weekly counts show totals through each week's last selected day. The table shows each week's included date range. Grouping leaves campaign totals and individual activity unchanged; CSV exports retain daily detail.

Click **N Events / N Unique contacts** at the top, or press `n`, to count distinct phone numbers. For incoming traffic, the summary shows unique texters, unique callers, and unique contacts across both channels. Someone who calls twice and texts three times contributes five events but only one unique contact. The phone-line list and all chart styles follow this choice; individual activity still shows every event. Numbers are normalized across phone formatting and channel prefixes. Withheld callers and other unidentified/non-phone addresses are excluded from unique counts; phone numbers represent contacts, not verified individual people. With outgoing traffic selected, unique counts refer to recipient numbers; both directions deduplicate the same number across inbound and outbound traffic.

Daily and weekly unique counts deduplicate within each bucket. Cumulative unique counts deduplicate across the entire selected window, so returning contacts are counted once even across weeks. Combined contacts are a union of callers and texters, never their sum. Unique bars show combined contacts to avoid stacking overlapping audiences; line and sparkline views include each channel and the union. Missing data stays marked as incomplete, and unique comparisons to the previous window are unavailable. CSV exports in unique mode label unique counts explicitly and retain daily detail.

The overall unique-contact total also deduplicates across lines and accounts: someone texting both a production line and a marketing line counts as **one** contact overall. Each line still counts that person once in its own row, so adding line totals can exceed the overall total. The dashboard displays a reminder in unique mode.

Press `v` or click LINES / ACTIVITY to view individual messages and calls in the same window, newest first. `m` cycles all events, messages only, or calls only. Use arrows to scroll, or PageUp/PageDown to scroll ten records at a time. The selected record's SID is shown below the list. Activity also follows a selected line's detail view. The list uses saved traffic metadata; press Enter or click **Open details** to read the selected record from Twilio.

## Read-only message and call details

Message details show the text, status, delivery error code and explanation, timestamps, segment count, and media count when returned by Twilio. Call details show status, start/end times, duration, and available call metadata. Failed or undelivered records receive a highlighted error summary.

Calls also have two tabs:

- **Webhook exchanges** shows each request's URL, HTTP method, and parameters alongside its HTTP response code, response time, and response body, including TwiML. HTTP errors are highlighted. [Twilio makes call events available about 15 minutes after a call ends](https://www.twilio.com/docs/voice/api/call-event-resource).
- **Errors & warnings** reads the call's Twilio notification records and shows severity, error code, explanation, timestamp, and request URL when available.

Each tab fetches only when opened, using the selected record's account profile. `r` reloads; arrows or the mouse wheel scroll; Esc returns to activity. These screens offer no send, edit, delete, or webhook replay actions. Message bodies, webhook exchanges, and diagnostics stay in memory while viewing them and are not added to SQLite, settings, or CSV exports. Call audio is not fetched. Unavailable records and permission failures appear in the detail screen.

## Saved views

Press `s` or choose **Saved views** from Actions. Choose **Name this view**, enter a name, and click **Save / update view**. Reusing a name updates it; names are compared without regard to case. Select a saved view and press Enter or click **Load selected** to restore it. **Remove selected** removes that saved configuration.

Views remember loaded accounts, focused account, filter, exclusions, direction, timezone, dates, chart style and grouping, cumulative/period mode, chart visibility, unique/event mode, and any selected campaign line. Rolling windows, MTD, and QTD stay relative to today when restored; historical windows retain their end date. Named views persist in the local `.twilio-tui.json` settings file.

## Dashboard

For a campaign, choose its account and click the campaign's number (or select it with arrows and press Return). Choose the campaign dates with `w`. The header identifies the selected number and account; the summary shows **texts received**, **calls received**, and **total events = texts + calls** over those dates. Incoming traffic is selected by default, so outgoing replies and outbound forwarding legs stay out of campaign response counts. Each received text and original incoming call counts as an event, including repeated responses from the same caller.

Press `v` to inspect the individual messages and calls behind the totals. The activity list follows the same number, account, direction, and dates; filtering the list to texts or calls does not change the overall summary. Esc returns from campaign detail to the number list. The overview combines the numbers in the accounts currently in view.

On wide terminals the chart and the line table sit side by side; on smaller ones they stack. Metric cards collapse into a single line when space is tight, and the line table drops the trend column before it shortens names.

- The **metric cards** show texts received, calls received, total events, and lines with traffic. With IN + OUT selected they also break down in vs out, and Δ compares each with the previous period of the same length.
- The **direction tabs** (IN + OUT · INCOMING · OUTGOING) change what every number on screen counts.
- **Line detail** (Enter on a line) shows that line's chart and counts; the title shows its account, name, and number, and a ◂ BACK tab appears.
- ⚑ marks unusual days, with at least three times the daily average (and at least five events); in the line table it shows how many such days a line had.
- The status in the top right reads `SAVED` with the last refresh time, `SYNCING` while refreshing, or `STALE` if the last refresh failed (the previous data stays on screen).

All tabs — accounts, direction, range, and UTC/LOCAL — can be clicked, as can rows in the line table.

## Keyboard reference

The dashboard keeps direction, dates, and the current view together in two compact rows. The clickable footer opens Actions, dates, activity, downloads, accounts, and help. Download progress appears only while downloads are running.

Click **Actions**, or press Space, for the full actions menu. Click an action to open it; the mouse wheel and Previous/Next buttons reach actions below the visible page. It includes filters, chart settings, export, and other secondary actions. Filters have clickable Apply, Cancel, and Clear controls. Exclusions support clicking numbers to toggle them, adding a typed number, and returning with Done. History date edits have Apply/Cancel buttons; account selection also has All connected, Active CLI, and Reload buttons.

Click a chart point, bar, sparkline position, or table row to see its underlying activity. Period counts select that day, week, or compressed date bucket; cumulative points select from the window start through that point. The chart and campaign summary keep their original window. **Full window** restores all activity; Esc also clears the chart selection before leaving activity or number detail. Click an activity row to select its timestamp, account, SID, and phone numbers in the detail line. Use the mouse wheel to scroll activity, phone lines, account lists, exclusions, and help. Help has clickable Close and Actions controls. Text entry still uses your keyboard; shortcuts are optional for these workflows.

Press `?` for the full reference and use ↑/↓ to scroll. Compact Mac keyboards need no function keys, Page Up/Down, Home/End, Option, or Command shortcuts. Return is Enter, and the Mac Delete key works as Backspace. Esc closes a screen or leaves detail/activity; on the main dashboard it keeps the app open. `q` quits.

| Key | Action |
| --- | --- |
| `Space` | Open the actions menu; ↑/↓ choose, Return opens, Esc goes back |
| `0`–`6`, `←` `→` | Show 1, 7, 30, 90, 180 days, 1 year, or 2 years |
| `w` | Exact start/end dates and presets |
| `-` / `=` (or `+`) | Previous / next whole window |
| `PageUp` / `PageDown` | Optional: previous / next window; page through activity |
| `c` | Cumulative / period counts; reopens cumulative if hidden |
| `i` | Daily / weekly chart grouping (Monday–Sunday, selected dates only) |
| `n` | Events / unique contacts for the summary, charts and phone-line list |
| `g` | Hide / show the chart; keep totals visible and expand the list |
| `v` / `m` | Lines / activity; all events / messages / calls |
| `s` | Save, load, or remove named dashboard views |
| `d` | Direction: incoming only (default), outgoing only, in + out |
| `t` | Chart: line (default), stacked bars, sparklines, daily table |
| `z` | Day boundaries in UTC or local time |
| `Tab` / `Shift+Tab`, `]` / `[` | Next / previous account (one at a time) |
| `a` | All loaded accounts combined |
| `p` | Choose which accounts are loaded |
| `↑` `↓`, `j` `k` | Select a line; in line detail, step through lines |
| `Enter` | Campaign totals for the selected number; open the selected record in activity |
| `Backspace` / `Esc` | Leave line detail or activity; Esc on the main view keeps the app open |
| `/` | Filter lines by name or number |
| `Ctrl+U` | Clear the filter |
| `x` | Exclude outside numbers (test phones) |
| `e` | Export CSV |
| `r` / `Shift+R` | Refresh now / reload the selected range, preserving history |
| `b` | Open history downloads |
| `u` | Preview and download missing history for the viewed window |
| `,` / `.` | Browse one week older / newer |
| `<` / `>` | Browse one month older / newer |
| `h` | Return to today |
| `?` | Keyboard help |
| `q` | Quit |

## CSV export

`e` writes `twilio-tui-YYYYMMDD-HHMMSS.csv` to the current directory. It reflects the account in view, selected campaign number (while in detail), traffic direction, filter, exclusions, range, and time zone (dates are in the column `date_utc` or `date_local`). With Incoming selected, outgoing columns are zero and the event total counts only received texts and calls. Columns:

`scope, date, account, line, name, messages_in, messages_out, calls_in, calls_out, total, coverage`

`scope` is `total` (one row for the whole range), `daily` (one row per day), or `line_daily` (one row per line per day). `coverage` is `complete`, `partial`, or `missing`; missing daily counts are blank, and partial totals contain observed counts only. This prevents unsaved days from being exported as confirmed zero traffic.

## Data

Twilio-TUI uses `twilio api:core:messages:list`, `twilio api:core:calls:list`, and `twilio api:core:incoming-phone-numbers:list` with TSV output and selected properties. SMS, MMS, and WhatsApp share Twilio's Messages resource; WhatsApp traffic is counted on the same line as the number it uses. Call totals count call attempts, including unanswered calls. Forwarded call legs (`outbound-dial`) are counted as outgoing calls on the line that received the original call.

Opening details uses read-only `messages:fetch` or `calls:fetch` requests. Call webhook and diagnostic tabs use `calls:events:list` and `calls:notifications:list` respectively. None of these detail responses are written to the saved traffic archive.

Automatic sync initially fetches 60 days per account. After that, events are saved to disk and reused across launches and the ten-minute refresh only requests the last two days. Widening the viewed range reads saved data; older downloads are controlled separately with `b`. Switching account, filter, exclusions, direction, range, or time zone redraws instantly from the cache. Friendly names refresh every ten minutes. If one account fails, the others still show with a warning naming the skipped account.

No credentials are stored by this app. The account selection, focused account, filter, exclusions, and named views are saved in the ignored `.twilio-tui.json` settings file (an existing `.twilio-traffic-pulse.json` is read once for migration); CLI credentials remain managed by Twilio CLI.

## Saved data and history

Successful pulls automatically save normalized events, line names, and coverage to `.twilio-tui.sqlite` (ignored by Git, owner-only permissions). This contains phone numbers and traffic timestamps, but no message bodies or credentials. Set `TWILIO_TUI_CACHE` to choose another database path. Existing `.twilio-tui-cache.json` data is imported once on startup; the original is retained as a backup. An existing custom path ending in `.json` is migrated to a sibling `.sqlite` file. Saving failures appear in the footer.

A launch reuses saved data when it covers the selected range and was refreshed within ten minutes. Automatic refresh runs every ten minutes; `r` refreshes immediately. Older events stay saved as new events arrive.

Press `,` to browse one week earlier, `.` for one week later, `<` / `>` (Shift+comma / Shift+period) to move a calendar month, and `h` to return to today. History browsing uses saved events; the background importer continues independently unless paused; the range, accounts, filters, and CSV export apply to the historical view. Coverage summaries identify incomplete current or comparison windows; unsaved days are marked unknown. To extend saved history, press `b` and configure history downloads. `Shift+R` reloads recent traffic from Twilio while preserving the historical archive and import progress.

SQLite uses Bun’s built-in driver, with no additional service or dependency. Event updates and saved coverage commit together in a transaction; refreshes write only fetched events. An indexed date query loads only the displayed range and its comparison period into the UI. Coverage can contain multiple separate date ranges; downloading an older window preserves unknown gaps between it and recent data. Existing continuous caches are migrated conservatively, treating their last refresh day as partial.

## History downloads

Press `b` to open the separate history download screen. Use ↑/↓ to choose an account and Space to include or exclude it from downloads, independently of the account currently in view. `g` sets the oldest requested date in UTC (`YYYY-MM-DD`); Enter applies, Esc cancels, and Ctrl+U clears the draft. `i` cycles pacing between one day every 1, 5, 10, or 30 minutes. `s` starts/resumes or pauses; Esc or `b` returns to the dashboard. New installations start paused. Account choices, target date, pace, and pause state persist.

The background importer uses read-only Messages and Calls list requests, with exact UTC-day filters. The general download mode extends each selected account’s recent saved range backwards to the requested oldest date, one day at a time. Window mode fills only missing days between its displayed start/end dates, skips already saved days, and resumes using saved coverage across restarts. It saves events and the resume checkpoint in one SQLite transaction. API pagination uses up to 1,000 records per page; thousands of calls per day are supported. Failed or cancelled days do not advance coverage.

The download screen shows each account’s saved date range, next date, and current operation with elapsed time and waiting/retry status. The dashboard shows a compact summary; click it or press `b` to manage downloads. Pausing cancels the current request without committing a partial day, and resuming continues from the last saved day. The app must stay open for downloads to continue. Selecting no accounts pauses downloads. Changing the target can extend a previously completed download. An already scheduled wait is retained across restarts and setting changes.

**The app no longer creates Bulk Export jobs.** It does not trigger export-job notification emails or change anyone’s notification preferences. Existing Twilio jobs may still finish, and existing SQLite records and legacy export checkpoints are retained.

Automatic history stops at the common readable window for both Messages and Calls—approximately 13 months, or earlier if the account has less history. Older dates remain viewable if already saved. Retrieving older unsaved records requires a deliberate archive download/import; this is not automatically scheduled. Twilio sends export-job initiation notifications to account owners/admins by default, so any future archive workflow must make that effect explicit. [Twilio Bulk Export](https://www.twilio.com/docs/usage/bulkexport)

The 180-day, 1-year, and 2-year views read the saved archive and warn if either the view or comparison range is incomplete. Selecting them never triggers a large historical list request: automatic recent sync is capped at 60 days and the background importer fills older dates gradually. History starts from a single all-time total-usage summary, without querying account details or enumerating usage categories.

## Troubleshooting

### Blank or shaded charts

Check the **DATA** row for partial or missing days. Missing history is unknown, so it is shaded rather than plotted as zero. A gap near the start can hide the rest of a cumulative chart. Press `c` to switch to period counts, or use **Period counts** in the missing-history explanation. Press `w` to choose a shorter window with saved data, or `u` to preview downloading missing days.

Today's **SO FAR** label is expected: the current day and its week are still in progress. A `≥` total means the app has observed at least that many events or contacts, with some coverage still incomplete. See [Time windows and activity](#time-windows-and-activity) for coverage markers.

### Older history is missing or downloads are not moving

Selecting a longer date range reads the local archive; it does not start a history download. Press `u` to preview missing days for the current window, select the accounts, then press `s` to start. Press `b` to check progress, selected accounts, pause state, and pacing. New installations start with history downloads paused, and the app must stay open for downloads to continue.

Waiting between days follows the selected pace. Failed requests show retry status and do not mark the day complete. Dates outside the app's API history boundary cannot be filled by this downloader; older data already saved remains viewable. See [History downloads](#history-downloads).

### Authentication or account-access failures

Run `twilio profiles:list` in your shell to check the available CLI profiles. Authenticate the intended account with the Twilio CLI (`twilio login`) if needed. In the TUI, press `p`, use **Reload**, select the intended profiles, and apply with `d`.

If authentication works but a feature reports an access error, check the [feature access requirements](#requirements) for that account. Details use the selected record's profile, which may differ from your active CLI profile. A successful dashboard sync does not confirm access to call events or diagnostics. After correcting access, press `r` in the affected detail tab, or on the dashboard for a sync failure. Saved traffic remains available when a refresh fails; check the error message and **STALE** status.

### Details or webhook records are unavailable

The activity list comes from the local archive, while opening details reads the record from Twilio. A saved activity row can remain visible even when Twilio no longer returns its full record. Check the account and any access error first; local metadata cannot reconstruct unavailable message bodies or webhook responses.

For a recent call, [Twilio makes webhook event records available about 15 minutes after the call ends](https://www.twilio.com/docs/voice/api/call-event-resource). Wait, open **Webhook exchanges**, and press `r` to reload. Older exchanges or diagnostics may no longer be available. For other failure information, inspect the call's **Details** and **Errors & warnings** tabs.

## Development

```sh
bun test
bun run typecheck
```
