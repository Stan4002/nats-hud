# NATS HUD Dev Notes

This document captures the current state of the NATS HUD GNOME Shell extension for the `feature/interactive-mode` branch. It summarizes architecture, refactors, telemetry flow, runtime concerns, and the current validation status.

## Scope and constraints

- Do not rebuild the project.
- Do not touch `main`.
- Do not merge branches.
- Do not commit automatically.
- Keep the architecture stable while iterating on the interactive panel.

## NATS HUD / NATS Assistant boundary

**NATS HUD** is the provider-agnostic GNOME Shell presentation layer. It is responsible for telemetry visualization, assistant summaries, task/calendar/comms presentation, focused system views, and dispatching assistant intents. Its task reads and completion/deletion requests use the local NATS Assistant API at `http://127.0.0.1:8765`; `+ TASK` launches external quick entry and refreshes tasks/home after process completion. `+ CAPTURE` remains out of scope.

**NATS Assistant** is the separate local backend/core and authoritative owner of task persistence and normalized calendar events. HUD requests use asynchronous GJS Soup 3 with short timeouts; the HUD caches the last successful task/home data in memory. The legacy tasks JSON is only an offline startup fallback until the backend has successfully supplied tasks; the HUD does not write it. Do not add external providers or move backend logic into the HUD.

### Milestone 5 TODAY calendar

TODAY uses `/v1/home` → `_assistantHome.calendar`: `status`, `today_count`, `next`, `events`, and `truncated`. The client retains only normalized event fields and ignores invalid events without discarding task information. NEXT uses the backend's `next` event, with local 24-hour time and a compact location. NOW uses an event whose start/end interval contains the current time, otherwise the existing focus title or `No active focus`. UPCOMING shows at most two future events from `events`, excluding NEXT. TODAY'S EVENTS shows at most two events in chronological order, with a compact indication when additional events exist. All-day events display `All day`; month dots mark the known event intervals, including exclusive end handling. The backend summary is a bounded preview, not a complete month feed.

An online empty calendar shows `No events today`. Not-connected, offline, and error states show controlled calendar status text while preserving the calendar grid and task section. The existing successful home-refresh path rerenders selected TODAY; no calendar timer or additional endpoint is introduced.

Transitional `calendar.json`, `comms.json`, and `focus.json` readers and their file monitor remain. TODAY only falls back to local calendar events when the backend calendar field is absent and the assistant has no offline/error state. A present backend calendar, including empty or unavailable states, always takes precedence. Local focus remains NOW's fallback when no backend calendar event is active. TASKS and its mutation/quick-entry paths are unchanged.

The passive CALENDAR card now also prioritizes `_assistantHome.calendar`, including for month dots. NOW uses a currently active backend event; NEXT uses `calendar.next`, with local 24-hour time or `All day`, and an optional location in its existing metadata label. UPCOMING shows at most one remaining future backend event without repeating NEXT. TASKS uses one compact pending/due-today count row from home state. Present backend empty/not-connected/offline/error states suppress local calendar data; an absent calendar field retains the local fallback. Existing home refresh and error handling update the passive card without extra timers or cached calendar state. Passive text contrast changes are scoped to ambient headings, reminders, and weekdays; font sizes and geometry are unchanged.

### Milestone 5.6 greeting and daily verse

The passive header now uses `GOOD MORNING`, `GOOD AFTERNOON`, or `GOOD EVENING`, optionally followed by the configured display name, with `Daily overview` below it. The existing TODAY date/time row and all assistant summary sections remain. Local-hour boundaries are 05:00, 12:00, and 17:00; 17:00–04:59 is evening. Names are whitespace-normalized, bounded for display, and uppercased. Header text stays on one line and ellipsizes without changing card dimensions.

Extension Preferences → Personalization controls `display-name` and `show-daily-verse`. Portable schema defaults are an empty name and verses disabled. This local development setup uses user GSettings values for `Stan` and enabled verses; no personal name is embedded in the distributable code or dataset. Clear the name for an unnamed greeting; turn off Daily KJV verse to disable verses.

`assets/verses-kjv.json` bundles 16 complete short KJV verses with IDs, references, translation, and categories. Quotations were checked verbatim against [Project Gutenberg's KJV text](https://www.gutenberg.org/ebooks/10), identified there as public domain in the USA. The asset is loaded once at extension enable through the extension's directory and Gio; missing/malformed/empty data silently disables the verse. There is no runtime Bible API or database.

The local `YYYY-MM-DD` date selects a cyclic verse using calendar-day arithmetic modulo the dataset length. It is stable all day and after reboot for the same bundled dataset; daylight-saving changes do not change the selection. The existing `_updateAmbientCard()` tick updates greeting text only when it changes and selects a verse only when the local date changes. New settings use the existing settings signal and update only personalization. No timer or new signal is introduced; actor references and verse cache are cleared on disable.

The enabled verse section is built just below TODAY: `VERSE`, a one-line quote preview, and `reference · KJV`. Visibility depends on the setting and bundled data, never actor allocation or preferred height. Pango end ellipsis prevents wrapping; the preview is capped at 100 characters. Only optional quote detail depends on the existing monitor/work-area geometry: below 180px rail width or 600px rail height, the reference remains and the quote is omitted. The current 1366×768 desktop shows both. Existing fonts/colors and card geometry are unchanged; the verse group's 2px spacing and reference's 7px styling remain.


### Final Milestone 5.x passive integration

TASKS is now a persistent single-line count label before the month grid, authoritatively using `_assistantHome.tasks.pending` and `due_today`, independently of the bounded `items` preview. Zero pending/due tasks show `No pending tasks`. Before home arrives it shows `Loading tasks`, or a controlled offline/error state; an already-loaded backend task cache may supply a pending count. Transitional local `tasks.json` is not the passive primary source. There is no passive task-title list.

EVENTS uses only normalized backend calendar state: `today_count`, falling back to local-day overlap of normalized `events` if the count is absent. Completed events still contribute to today's count without being repeated under NOW/NEXT. NEXT accepts only a future backend `calendar.next`; NOW uses only an active interval or focus fallback. UPCOMING contains at most one future event beyond NEXT and is omitted when empty, together with empty NEXT metadata. Calendar unavailable/not-connected states stay controlled. LAST is intentionally omitted to keep this compact.

Existing home refresh success/error paths update passive task/event labels in place and never remove the verse or greeting. No timer, allocation polling, new signal, or task/interactive/telemetry behavior is introduced at this integration stage. The original live disappearance of TASKS could not be attributed to a data or explicit visibility guard in the inspected source: it already built counts, below the calendar. The integration removes that low placement and label recreation; subsequent live GNOME validation confirmed the passive task and verse presentation.

Preferences groups are General (opacity/quick actions), Telemetry (existing interval/card visibility), and Personalization (display name/daily verse). Task/event summaries remain always-on; no artificial visibility settings or greeting toggle are added. All 12 schema keys and types are checked, including the existing shortcut; portable personalization defaults remain unchanged. Display-name binding and the existing extension settings signal update personalization immediately without rebuilding the rail. Compile schemas before first loading this updated version; subsequent preference changes need no restart.

Run `node tests/passive-overview.mjs` for the mocked passive builder, home refresh/lifecycle, event/task/verse matrix, allocation independence, greeting/midnight, and source/schema parity checks. The checks execute actual extension methods against actor mocks, and remain separate from the runtime.


### Final Milestone 5 UX refresh, calendar, and keyboard

Passive home data previously had no enable-time fetch or recurring home refresh: entering interactive mode and explicit actions triggered backend reads, while the telemetry tick only redrew cached home data. Enable now starts one independent 45-second assistant-home GLib source and an immediate `/v1/home` fetch. The telemetry interval/ownership is unchanged. Interactive entry, task mutations, and quick-entry completion retain their existing refresh calls. Concurrent home triggers share the active request and coalesce into one sequential follow-up, so a mutation cannot leave only a pre-mutation snapshot. Disable removes the source before disposing the client; inactive-client guards prevent late replies from touching actors. Calendar/backend errors remain isolated from telemetry.

`src/calendar.js` now builds and updates both month grids using the existing interactive `nats-calendar` design family: Monday-first weekdays, uppercase month/year, the same current-day highlight, and normalized-event overlap dots with exclusive end handling. Passive mode uses a compact variant within unchanged rail geometry and is nonreactive. Unchanged passive date/marker state skips grid reconstruction. Interactive days are real focusable buttons, with a separate selected border/inset state while today's background remains distinguishable.

`_assistantSelectedDate` stores a local `YYYY-MM-DD` key. Interactive opening and returning to TODAY from another pager page default to today; home refresh and focused-view/BACK retain selection/page state. Clicking a day, Enter, keypad Enter, or Space selects it and restores focus to that day's replacement button. The events heading remains `TODAY'S EVENTS` for today, otherwise `EVENTS · DD MON`. Previews contain at most two loaded backend events overlapping the selected date, including `calendar.next` when it is in another day; missing other-day data says `No loaded events`. No provider/endpoint fetch or system-date change occurs. Month navigation is intentionally omitted.

The existing stage capture now handles Left/Right using `_setAssistantPage`, exactly preserving pager clamping/dots. The rail takes actor keyboard focus on opening and after BACK. Arrow paging requires focus within the interactive panel and the assistant control section; editable text/entries and calendar-day focus are excluded. Calendar arrows are left to normal focus behavior; only Enter/Space explicitly select dates. Escape retains its existing close behavior. There is no wheel paging, new modal grab, or transparent hit target. Focused calendar days are restored after home-driven TODAY rerenders.

Mock validation: `node tests/passive-overview.mjs` also checks passive periodic/initial fetching, one source, disable cleanup, independent telemetry during outage, coalesced requests, shared markers/formatting, selected dates and loaded/unloaded previews, click/Enter/Space, pager arrows/clamping/dots, focus exclusions, Escape, and focused-view/BACK page preservation.

Live check after loading the updated extension in a fresh Wayland session: stay passive for at least 45 seconds and verify backend counts/events without opening the HUD; then open interactive mode, select today/another loaded day/an unloaded day, compare the compact/full calendars, test arrows on normal rail focus and Enter/Space on a day button, verify BACK retains the page and Escape closes. Preference behavior and the known focused-view allocation warnings are unchanged.

The 6 October 2026 milestone checkpoint is live-validated: passive refresh, backend tasks and Google Calendar, greeting/verse, task/event summaries, shared calendars, date selection/event previews, keyboard paging, task CRUD, preferences, and existing telemetry work. Small passive text, cramped month/year text, density/alignment, and selected-date styling remain deferred visual polish; they do not block this checkpoint.

Manual checks after compiling schemas and a fresh Wayland session:

```sh
glib-compile-schemas --strict schemas
gnome-extensions prefs nats-hud@stan
gsettings --schemadir schemas set org.gnome.shell.extensions.nats-hud display-name 'Stan'
gsettings --schemadir schemas set org.gnome.shell.extensions.nats-hud show-daily-verse false
gsettings --schemadir schemas set org.gnome.shell.extensions.nats-hud show-daily-verse true
journalctl --user -f -o cat /usr/bin/gnome-shell
```

Keep the extension's existing reload/session-cache caveat in mind. Check the greeting/date, verse on/off and long-name ellipsis, then verify NOW/NEXT/TASKS and interactive TODAY → TASKS → ASSISTANT. Greeting boundaries, date rollover, empty data, and tight-space fallback are covered by mocked GJS checks; do not alter the system clock to test them.

## Core architecture

The extension intentionally keeps two distinct UI layers:

1. Full desktop HUD stays in:
   - `Main.layoutManager._backgroundGroup`
2. Compact interaction panel stays in:
   - `Main.uiGroup`

This is the required architecture and must remain unchanged.

Do not:
- move the full HUD into `Main.uiGroup`
- create transparent fullscreen hit targets
- create reactive fullscreen overlays
- restore the archived laggy experiment

## Interaction system status

Current interaction mode behavior is intended to be:

- Open with `Super + Shift + N`
- Default section is `control`
- CPU has a real focused view
- Memory has a real focused view
- Other sections remain placeholders for now
- Back returns to `control`
- Escape closes interaction mode completely

State model used in code:

- `this._activeSection = 'control'`
- valid values include:
  - `'control'`
  - `'cpu'`
  - `'memory'`
  - `'network'`
  - `'storage'`
  - `'system'`
  - `'activity'`
  - `'comms'`

Current real focused sections:
- `control`
- `cpu`
- `memory`

Everything else remains a placeholder log only.

## Current interaction flow

The interaction panel is a reusable section-driven UI with flows conceptually equivalent to:

- `_renderInteractionSection(section)`
- `_buildControlView()`
- `_buildCpuView()`
- `_buildMemoryView()`
- `_updateActiveInteractionView(snapshot)`

The outer interaction panel itself should remain stable while interactive mode is open; only the content container is replaced when switching sections.

This avoids unnecessary actor rebuild churn while reducing the risk of lifecycle errors.

## CPU-focused view

The CPU focused view includes:
- aggregate CPU usage
- CPU temperature
- per-core usage rows
- load averages
- CPU history sparkline
- Back action
- Open BTOP action

Telemetry is not duplicated for this view.

CPU values update from the same live telemetry lifecycle used by the background HUD:
- `this._telemetry.readSnapshot()`
- `_updateMetrics(snapshot)`
- `this._lastSnapshot = currentSnapshot`
- `_updateActiveInteractionView(currentSnapshot)`

## Memory-focused view

The Memory focused view was implemented as the second real focused section.

It displays:
- memory percent used
- used / total memory
- available memory
- cache memory
- swap used / total
- memory usage bar
- Back action
- Open System Monitor action

This uses the existing live memory telemetry snapshot and does not create new polling logic.

Memory view fields used in the current snapshot are the ones already produced by the telemetry layer, including:
- `memory.totalBytes`
- `memory.usedBytes`
- `memory.availableBytes`
- `memory.usagePercent`
- `memory.cachedBytes` when present
- `memory.swapTotalBytes` when present
- `memory.swapUsedBytes` when present

## Telemetry design

The extension should remain on a single telemetry lifecycle.

Required behavior:
- One `SystemTelemetry` instance
- One timer from `GLib.timeout_add_seconds(...)`
- One refresh path in `_updateMetrics()`
- Reuse the same snapshot for the main HUD and any active focused view

Do not add:
- a second `SystemTelemetry()`
- a second polling loop
- a second timer
- a second `/proc` read path for the interaction panel

The current design uses:
- `this._telemetry`
- `this._lastSnapshot`
- `this._cpuHistory`
- the active section update path

## Lifecycle and stability notes

A runtime issue involving `TypeError: can't access property "get_transition", this.actor is null` was investigated and traced to the lifecycle risk introduced by CSS transitions and actor destruction/rebuild churn.

The fix approach used was deliberately conservative:
- remove transition-duration entries from interaction/button styling
- keep the panel persistent instead of rebuilding the outer panel repeatedly
- clear per-view references when switching away from a section
- destroy stale/unused references safely

This was a targeted stability correction. It is not a broad redesign and does not add animations or new CSS transition behavior.

## Actor reference safety rules

When switching sections, the project should:
- clear CPU-specific refs when leaving CPU view
- clear Memory-specific refs when leaving Memory view
- verify refs are not left pointing at destroyed actors
- avoid stale child references after panel content replacement

Examples of references that may exist in this codebase:
- `this._cpuInteractionRefs`
- `this._memoryInteractionRefs`
- usage labels, temp labels, sparkline labels, core rows, memory fill/tracks

These must be reset when leaving their section, and recreated when the section is shown again.

## Control section behavior

The Control section contains:
- section buttons for CPU, Memory, Network, Storage, System, Activity, Comms
- quick actions: BTOP, SYSTEM MONITOR, FILES, TERMINAL

Current behavior:
- CPU opens CPU focused view
- MEMORY opens Memory focused view
- Network, Storage, System, Activity, Comms remain placeholder logs only
- Quick actions remain unchanged

## Launcher behavior

The memory focused view uses the existing launcher:
- `openSystemMonitor`

This is the correct deep-dive path for Memory.

The CPU view uses:
- `openBtop`

Quick actions remain unchanged.

## Validation and checks performed

Static validation performed successfully:

- `node --check extension.js`
- `glib-compile-schemas --strict schemas`
- `git diff --check`
- `git status --short`
- `rg -n "_activeSection|memory|_updateActiveInteractionView|new SystemTelemetry|timeout_add|Main\\.uiGroup|_backgroundGroup|destroy\\(" extension.js`

Observed result:
- no syntax errors
- schemas compile cleanly
- no diff-formatting issues
- no duplicated telemetry or timer creation in the extension code
- full HUD remains in `_backgroundGroup`
- interaction panel remains only in `Main.uiGroup`

## Runtime caveat / current status

This project has had static validation and a reload attempt via:

- `gnome-extensions disable nats-hud@stan`
- `gnome-extensions enable nats-hud@stan`

This is not equivalent to a full GNOME logout/login. The lifecycle fix and memory view should be treated as provisionally stable until a fresh GNOME session is tested.

The codebase is currently in a state where:
- static checks pass
- runtime reload completed without errors in the current environment
- a full session reboot remains the best verification step for the final lifecycle confidence

## Known safe operations

These behaviors are expected to remain stable when validated in a live session:
- `Super + Shift + N` enters interactive mode
- default section is `control`
- CPU opens the CPU panel
- Back returns to `control`
- Escape closes interaction mode
- Memory panel opens from the control page
- Back returns from Memory to Control
- `OPEN BTOP` opens the BTOP launcher
- `OPEN SYSTEM MONITOR` opens the system monitor launcher
- other buttons remain placeholder logs only

## Not implemented yet

The following are intentionally not implemented in this milestone:
- Network focused view
- Storage focused view
- System focused view
- Activity focused view
- Comms focused view
- process list UI
- memory cleanup optimizers
- RAM optimization controls
- AI/assistant features
- animations
- resizing/dragging controls
- transparent reactive overlays

## Suggested next steps

Recommended follow-up sequence:

1. Perform a fresh GNOME logout/login and validate the interaction panel in a true session.
2. Confirm the `TypeError: can't access property "get_transition", this.actor is null` does not reappear after a complete Shell restart.
3. If stable, continue with the next target section (Network or Storage) only after that validation.
4. Keep the architecture anchored to the current two-layer design.

## Files of interest

- `extension.js` — main logic, telemetry flow, interaction modes, CPU/Memory views
- `stylesheet.css` — styling for interaction panel and memory bar
- `src/telemetry.js` — telemetry source used by the HUD
- `src/formatters.js` — formatting utilities for bytes, percentages, temperature, duration, and load
- `src/widgets.js` — reusable widget classes used by the HUD

## Final status

Current milestone summary:
- CPU focused view implemented and reused from telemetry lifecycle
- Memory focused view implemented and reused from telemetry lifecycle
- architecture preserved: HUD stays in background group, panel remains in `Main.uiGroup`
- static validation passed
- runtime session validation is still recommended before claiming full final stability

This document is intended as a living note for the current branch and the next development pass.
