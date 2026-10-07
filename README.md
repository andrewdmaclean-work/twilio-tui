# Twilio-TUI

A keyboard driven terminal dashboard for SMS/MMS/WhatsApp messages and voice calls, incoming and outgoing, across one or more Twilio accounts selected through the Twilio CLI.

## Requirements

- Bun 1.3 or newer
- Twilio CLI installed and authenticated (`twilio login`)
- Account permissions to list Messages, Calls, and Incoming Phone Numbers

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

Press `p` to open the account picker, which lists your saved Twilio CLI profiles with their Account SIDs.

- `↑` / `↓`: move · Space/Enter: tick or untick · `a`: tick all · `c`: untick all (use the active CLI profile)
- `r`: reload the list from the Twilio CLI · `d`: done (apply and save) · Esc: cancel

## Dashboard

On wide terminals the chart and the line table sit side by side; on smaller ones they stack. Metric cards collapse into a single line when space is tight, and the line table drops the trend column before it shortens names.

- The **metric cards** show messages, calls, total events, and lines with traffic. With IN + OUT selected they also break down in vs out, and Δ compares each with the previous period of the same length.
- The **direction tabs** (IN + OUT · INCOMING · OUTGOING) change what every number on screen counts.
- **Line detail** (Enter on a line) shows that line's chart and counts; the title shows its account, name, and number, and a ◂ BACK tab appears.
- ⚑ marks unusual days, with at least three times the daily average (and at least five events); in the line table it shows how many such days a line had.
- The status in the top right reads `LIVE` with the last refresh time, `SYNCING` while refreshing, or `STALE` if the last refresh failed (the previous data stays on screen).

All tabs — accounts, direction, range, and UTC/LOCAL — can be clicked, as can rows in the line table.

## Keyboard reference

Press `?` in the app for the same list.

| Key | Action |
| --- | --- |
| `1` `2` `3`, `←` `→` | Show the last 7, 30, or 90 days |
| `d` | Direction: in + out (default), incoming only, outgoing only |
| `t` | Chart: line (default), stacked bars, sparklines, daily table |
| `z` | Day boundaries in UTC or local time |
| `Tab` / `Shift+Tab`, `]` / `[` | Next / previous account (one at a time) |
| `a` | All loaded accounts combined |
| `p` | Choose which accounts are loaded |
| `↑` `↓`, `j` `k` | Select a line; in line detail, step through lines |
| `Enter` or click | Open line detail |
| `Backspace` / `Esc` | Leave line detail; `Esc` on the main view quits |
| `/` | Filter lines by name or number |
| `Ctrl+U` | Clear the filter |
| `x` | Exclude outside numbers (test phones) |
| `e` | Export CSV |
| `r` / `Shift+R` | Refresh now / clear the cache and reload everything |
| `?` | Keyboard help |
| `q` | Quit |

## CSV export

`e` writes `twilio-tui-YYYYMMDD-HHMMSS.csv` to the current directory. It reflects what is on screen: the account in view, the filter, exclusions, the range, and the time zone (dates are in the column `date_utc` or `date_local`). Columns:

`scope, date, account, line, name, messages_in, messages_out, calls_in, calls_out, total`

`scope` is `total` (one row for the whole range), `daily` (one row per day), or `line_daily` (one row per line per day).

## Data

Twilio-TUI uses `twilio api:core:messages:list`, `twilio api:core:calls:list`, and `twilio api:core:incoming-phone-numbers:list` with TSV output and selected properties. SMS, MMS, and WhatsApp share Twilio's Messages resource; WhatsApp traffic is counted on the same line as the number it uses. Call totals count call attempts, including unanswered calls. Forwarded call legs (`outbound-dial`) are counted as outgoing calls on the line that received the original call.

The first load fetches two periods of history per account (for the comparison). After that, events are cached in memory and the one-minute refresh only requests the last two days; widening the range only requests the missing older days. Switching account, filter, exclusions, direction, range, or time zone redraws instantly from the cache. Friendly names refresh every ten minutes. If one account fails, the others still show with a warning naming the skipped account.

No credentials are stored by this app. The account selection, focused account, filter, and exclusions are saved in the ignored `.twilio-tui.json` settings file (an existing `.twilio-traffic-pulse.json` is read once for migration); CLI credentials remain managed by Twilio CLI.

## Development

```sh
bun test
bun run typecheck
```
