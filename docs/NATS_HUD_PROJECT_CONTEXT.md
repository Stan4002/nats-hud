# NATS HUD Project Context

Canonical engineering handoff for a new Copilot session with no prior conversation context. Read this file before changing the project. It is based on the repository state inspected on 2026-10-05, including the checked-out branch, source, documentation, and current working-tree changes.

## CURRENT STATE

### Project and checkout

- **What NATS HUD is — IMPLEMENTED:** A GNOME Shell 50 extension that renders a translucent desktop system HUD and provides a compact keyboard-invoked interactive panel. It currently presents CPU, memory, network, storage, system, activity/history, power-placeholder, and quick-action areas.
- **Current branch:** `feature/interactive-mode`.
- **HEAD:** `adf789e Add compact NATS interaction panel`.
- **Mainline checkpoint:** `main`, `origin/main`, `origin/HEAD`, `feature/focus-cards`, and tag `v0.2.0-settings` point to `0df54e1 Merge HUD preferences`.
- **Working tree — UNCOMMITTED:** `extension.js` modified; `stylesheet.css` modified; `.vscode/settings.json` untracked; `docs/DEV_NOTES.md` untracked. Do not assume these changes are committed or physically verified. This context file is also being added as a new untracked document.
- **Other refs observed:** `feature/settings` points to `1da4d2d Add persistent HUD preferences`; `archive/focus-lag-experiment` points to `f5f8160`; tag `v0.1.0-desktop` points to `8be2234`.
- **No commit was requested or made.** Do not commit automatically.

### Implementation and verification status

Use these labels precisely; implementation in source is not proof of successful runtime behavior.

- **IMPLEMENTED:** Passive full HUD in `Main.layoutManager._backgroundGroup`; compact interaction panel in `Main.uiGroup`; Super+Shift+N keybinding; Escape handling; current CPU and Memory focused-view code; one `SystemTelemetry` object and one telemetry timer; existing telemetry cards and quick actions.
- **STATICALLY VALIDATED:** Earlier checks reported `node --check extension.js`, `glib-compile-schemas --strict schemas`, and `git diff --check` passing. Those checks were performed during earlier turns and before this document. Re-run them on the current complete working tree before relying on them.
- **PHYSICALLY VERIFIED:** Milestone 1B compact CONTROL panel was reported working in a live GNOME session: Super+Shift+N opens it; Escape closes it; it is in `Main.uiGroup`; background HUD remains in `_backgroundGroup`; no full-screen reactive backdrop; section request logs and Quick Actions worked; no persistent desktop lag was observed.
- **PENDING PHYSICAL VERIFICATION:** CPU and Memory focused views, their live updates, and the recent lifecycle changes have not been validated after a fresh GNOME logout/login. Treat runtime stability as provisional. Prior `gnome-extensions disable` / `enable` was reported to complete, but it is not a fresh Shell process and is not equivalent to logout/login.
- **PENDING PHYSICAL VERIFICATION:** The reported `TypeError: can't access property "get_transition", this.actor is null` must not be declared permanently fixed until checked after a fresh session. The repository's `docs/BUGS.md` also notes that a prior Shell session retained a stored `St.ProgressBar` error after disable/enable; confirm from a fresh Shell process whether it is stale or current.

### Current focused-section source status (not aspirational status)

- CONTROL is the default and renders the section and Quick Action buttons.
- CPU button switches to a CPU view. CPU view code renders aggregate usage, temperature, up to six per-core rows, load averages, history, BACK, and OPEN BTOP.
- MEMORY button switches to a Memory view. Memory view code renders used percentage, used/total, available, cache, swap, a usage bar, BACK, and OPEN SYSTEM MONITOR.
- NETWORK, STORAGE, SYSTEM, ACTIVITY, and COMMS buttons still log placeholder requests; there are no focused views for them.
- The current renderer normalizes only `cpu` and `memory` as focused pages; other section values fall back to CONTROL if passed to the renderer. Placeholder clicks do not request a focused page.
- The outer interaction panel is retained while active; section content/footer children are removed and rebuilt on section changes.
- `_createFocusedSectionShell()` exists, but **current CPU and Memory builders do not use it**. They fill the shared panel content/footer directly. Do not describe the helper as currently providing their shell until source is refactored to use it.
- **Memory telemetry mismatch:** `src/telemetry.js` returns `usedBytes`, `totalBytes`, `availableBytes`, and `usagePercent`. It does not currently return `cachedBytes`, `swapUsedBytes`, or `swapTotalBytes`; corresponding Memory view labels therefore show `--` unless telemetry is deliberately extended in a future, approved change.
- **Memory live-update mismatch:** `_updateMetrics()` saves `this._lastSnapshot` and calls `_updateActiveInteractionView(currentSnapshot)` only when `_activeSection === 'cpu'`. Although `_updateActiveInteractionView()` contains a Memory update branch, current source does not dispatch to it while Memory is active. Memory therefore must not be described as live-updating until this condition is fixed and tested.
- `_buildCpuView()` and `_buildMemoryView()` contain a fallback to `this._telemetry.readSnapshot()` if `_lastSnapshot` is absent. Normal enable flow populates `_lastSnapshot` first. Preserve the one telemetry instance and do not add readers or timers.

## What the project does

NATS HUD is an in-progress GNOME Shell extension for a persistent, visually restrained system-monitor HUD plus an explicitly invoked compact control surface. The current extension targets GNOME Shell 50 (`metadata.json`). It uses GJS ES modules, St/Clutter actors, Gio/GLib APIs, a GSettings schema, and Adw/Gtk preferences.

It is not an assistant service yet. “NATS Comms” is a future roadmap item described below, not an implemented feature.

## NATS HUD / NATS Assistant boundary

**NATS HUD** is the provider-agnostic presentation layer. It is responsible for telemetry visualization, assistant summaries, task/calendar/comms presentation, focused system views, and dispatching assistant intents. The `+ TASK` and `+ CAPTURE` buttons currently log intent requests only; they do not create tasks or communicate with a service.

**NATS Assistant** is a future, separate local service responsible for task ownership, calendar sync, comms sync, authentication, persistence, normalization, reminders, classification, and drafts. Keep this backend out of the GNOME Shell process; do not add provider integrations to the HUD.

## Architecture that must be preserved

### Two UI layers

1. **Desktop HUD:** `extension.js` adds the large, non-reactive HUD root to `Main.layoutManager._backgroundGroup`. It is positioned relative to the primary monitor, below the GNOME top panel. Its root is transparent and non-reactive so ordinary windows and desktop interaction are not captured.
2. **Interaction panel:** The only interaction actor added above normal windows is the compact panel added to `Main.uiGroup`. It is shown from the registered `toggle-interactive-mode` keybinding and removed from its parent on close. It is not a full-screen overlay.

The panel is positioned in the upper-right area of the primary monitor, currently with fixed dimensions of 360 × 320. Monitor changes reposition both layers. Keep all interaction hit targets limited to actual visible controls.

### One telemetry lifecycle

`enable()` constructs exactly one `SystemTelemetry`, obtains an initial snapshot, stores it as `this._lastSnapshot`, builds the background HUD, and starts the configured GLib timeout. `_updateMetrics()` reads one current snapshot per tick (or accepts a provided one), stores it as `_lastSnapshot`, updates existing main-HUD actors, and can update the active focused page. `disable()` removes the timer, signal handlers, keybinding, actors, and settings handlers.

Do not add a second telemetry instance, timer, polling loop, or focused-panel `/proc` reader. The one-second default is configurable from 1 to 10 seconds using `update-interval`.

### Module boundaries

- `extension.js`: orchestration, actor layout, focused pages, signal/timer lifecycle, and telemetry-to-widget updates.
- `src/telemetry.js`: system sampling and snapshot creation.
- `src/formatters.js`: safe formatting and clamping.
- `src/widgets.js`: reusable St actors/widgets.
- `src/launcher.js`: application process launchers.
- `prefs.js`: Adw/Gtk preferences UI backed by GSettings.
- `schemas/org.gnome.shell.extensions.nats-hud.gschema.xml`: settings keys/defaults/ranges.
- `stylesheet.css`: GNOME Shell/St styling.

## Current interaction and dashboard behavior

### Keyboard and section routing

- The GSettings key `toggle-interactive-mode` defaults to `['<Super><Shift>n']`.
- `Main.wm.addKeybinding('toggle-interactive-mode', ...)` handles open/toggle; `disable()` removes it.
- A captured stage event handles Escape while the compact panel is open.
- Opening starts at CONTROL. Closing resets `_activeSection` to CONTROL.
- CPU and Memory are the only focused pages in source.
- NETWORK, STORAGE, SYSTEM, ACTIVITY, and COMMS remain placeholder request logs.
- Quick Actions are BTOP, SYSTEM MONITOR, FILES, TERMINAL, separate from section navigation.

### CPU page

The CPU view uses the existing CPU snapshot and `_cpuHistory`. It displays aggregate CPU use, CPU temperature, up to six per-core indicators, three load averages, and a CPU sparkline. Footer actions are BACK and OPEN BTOP. Main-HUD core widgets are retained in a map and updated rather than reconstructed each telemetry tick.

### Memory page

The Memory view uses the snapshot's actual memory object. Reliable currently available fields are:

| Snapshot field | Meaning |
|---|---|
| `memory.usedBytes` | `MemTotal - MemAvailable` |
| `memory.totalBytes` | Total RAM |
| `memory.availableBytes` | Linux `MemAvailable` estimate |
| `memory.usagePercent` | Used/total percentage |

Cache and swap display elements exist in the view code but do not have corresponding fields in the current telemetry snapshot. Do not silently treat them as telemetry. Add those fields only if a future task explicitly asks for them and after inspecting Linux semantics; label unavailable data clearly.

Current code must also be corrected so `_updateActiveInteractionView(snapshot)` is dispatched for both CPU and Memory when active. This is a focused, tightly scoped follow-up needed before declaring the Memory page fully functional; do not use this handoff task as permission to change source now.

### Other live dashboard panels

The passive HUD includes CPU and memory cards, system uptime/load metrics, network rates/interface, root filesystem capacity, activity history, and Quick Actions. It no longer includes a standalone wall clock or a reserved POWER card. Network samples derive rates from counters and elapsed time; the first sample establishes a baseline. Storage is root filesystem capacity, not block-device I/O.

## Telemetry snapshot and limitations

`SystemTelemetry.readSnapshot()` currently provides:

- `cpu.usagePercent`, `cpu.cores[]` with `id` and `usagePercent`
- `memory.usedBytes`, `memory.totalBytes`, `memory.availableBytes`, `memory.usagePercent`
- `temperatureCelsius` (nullable when no readable sensor is available)
- `uptimeSeconds`
- `loadAverage.oneMinute`, `.fiveMinute`, `.fifteenMinute`
- `network.interfaceName`, `downloadBytesPerSecond`, `uploadBytesPerSecond`
- `storage.totalBytes`, `usedBytes`, `freeBytes`, `usagePercent`

CPU percentages require two samples. Network rates also require a previous counter sample. Temperature may be unavailable. Load average is not a CPU percentage; interpret it relative to core count. `MemAvailable` is preferable to `MemFree` for estimating reclaimable/available RAM.

The telemetry module currently does not parse cache/buffer or swap values from `/proc/meminfo`. It reads procfs/sysfs and filesystem metadata inside the telemetry component; the interaction panel should consume snapshots, not reproduce those reads.

## Historical decisions and failed approaches

### Stable main architecture and settings checkpoint

- `v0.2.0-settings` at `0df54e1` (`Merge HUD preferences`) is the stable main/settings checkpoint. At inspection, `main`, `origin/main`, `origin/HEAD`, and `feature/focus-cards` point there.
- This line retains the full HUD in the background group and adds persistent opacity, refresh interval, section visibility, and keyboard shortcut settings.
- `v0.1.0-desktop` at `8be2234` is the full desktop HUD checkpoint.

### Archived focus/lag experiment — never resurrect

- Branch `archive/focus-lag-experiment`, commit `f5f8160` (`Archive experimental focus input layer causing desktop lag`), and related stash-era work explored split/transparent input targets and focus layers.
- The approach caused desktop click latency, produced unreliable real interaction, and was intentionally abandoned.
- **Never merge `archive/focus-lag-experiment` into `main` or copy its transparent/split input-target technique into the active branch.**
- No full-screen reactive actor, transparent hit-target layer, or click-through experiment should be recreated.

### Milestone 1: whole HUD in `Main.uiGroup`

- Commit `b37dcc2` (`Prove explicit HUD interactive mode`) moved the whole HUD into `Main.uiGroup` as a proof that explicit interaction could work.
- It proved the interaction path, but covering applications was poor UX. It is a historical checkpoint, not the target architecture.
- The current solution keeps only the compact panel in `Main.uiGroup`.

### Current interaction solution: Milestone 1B

- Passive full HUD remains in `Main.layoutManager._backgroundGroup`.
- Compact `NATS // CONTROL` panel alone goes into `Main.uiGroup`.
- Super+Shift+N opens; Escape closes.
- No full-screen reactive overlay.
- This compact-panel arrangement was reported physically working, with correct request logs and Quick Actions, and without persistent desktop lag.

## Bugs, challenges, and lessons

### GObject actor construction

**Symptom:** `Tried to construct an object without a GType` when instantiating custom actor subclasses.
**Fix:** Subclasses of GObject-backed St actors in `src/widgets.js` use `GObject.registerClass()` and unique `GTypeName` values. Keep this pattern for new custom actor classes.

### `St.ProgressBar` unavailable

**Symptom:** `St.ProgressBar is not a constructor` in the target GNOME Shell 50 runtime.
**Fix:** `ProgressMetric` is composed from ordinary `St.Widget` track/fill actors and updates fill width. Do not reintroduce `St.ProgressBar` without verifying API support on the target Shell.

### `get_transition` / null actor error

**Reported error:** `TypeError: can't access property "get_transition", this.actor is null`.

The suspected/identified route was GNOME Shell's CSS transition machinery touching an actor during interaction content replacement/destruction. The project does not need explicit JS `ease()` calls for this path to occur. Mitigations already applied:

- Removed `transition-duration` from interaction/button styles (and the current stylesheet has no transition-duration declarations).
- Kept the outer interaction panel stable while replacing only section children.
- Cleared section-specific actor references when content is replaced.
- Avoided adding JS animations/easing.

These are mitigations, **not proof that the error is permanently solved**. Fresh logout/login testing remains pending. Check the journal after that fresh session; do not suppress errors or claim resolution based only on syntax checks.

### GNOME Shell and Wayland module caching

Disable/enable can retain a loaded module or stale extension error in the existing Shell process. A successful command or absence of a new trace during disable/enable does not prove a fresh runtime. Use a fresh GNOME login/Shell process when validating constructor and transition fixes; do not log out/reboot unless the user explicitly authorizes it.

### Background-group input limitations

`_backgroundGroup` is intentionally behind normal windows and is unsuitable as the ordinary interactive surface. Do not attempt to make the full-screen desktop HUD interactive using background actors or transparent hit regions. Put actual visible controls in the compact `Main.uiGroup` panel.

### Widget and telemetry lifecycle

Update actor properties rather than rebuilding telemetry UI every timer tick. Rebuild only the focused page's content on explicit navigation, clear refs when replacing that content, and update live page actors from the one current snapshot. Avoid callbacks retaining actors after destroy/removal.

### Process launching

`src/launcher.js` uses `Gio.Subprocess` with validated argv arrays, asynchronous exit checking, and error logging. Do not build shell command strings or invoke shell parsing for launch actions. Add launchers centrally rather than embedding process execution into view widgets.

### CSS

GNOME Shell uses a GTK/St CSS subset, not browser CSS. Avoid browser-only effects such as `backdrop-filter`. Keep transitions/animations out of the interaction surface until explicitly requested and runtime-validated.

## Static validation, physical verification, and runtime checks

### Previously reported static checks — STATICAL VALIDATION

Run from repository root:

```sh
node --check extension.js
glib-compile-schemas --strict schemas
git diff --check
git status --short
rg -n "_activeSection|memory|_updateActiveInteractionView|new SystemTelemetry|timeout_add|Main\\.uiGroup|_backgroundGroup|destroy\\(" extension.js
```

The earlier work reported all but `git status --short` as clean/successful checks; status naturally listed pending modifications/untracked files. Re-run before further changes because the source has since accumulated uncommitted work.

### Physical verification record

- **PHYSICALLY VERIFIED:** Milestone 1B CONTROL panel and keybinding as described above. Earlier journal logs included entering/exiting interaction mode and requested sections CPU, MEMORY, STORAGE, NETWORK, SYSTEM, ACTIVITY, COMMS.
- **NOT PHYSICALLY VERIFIED:** CPU focused view after implementation.
- **NOT PHYSICALLY VERIFIED:** Memory focused view after implementation.
- **PENDING:** Fresh logout/login to validate the lifecycle mitigation and current module load without stale cached extension code/errors.

No claim of full runtime validation should be made from `node --check`, schema compilation, `git diff --check`, or extension disable/enable.

## Git reference guide

Relevant refs/commits observed in `git log --oneline --decorate --all`:

| Ref/commit | Meaning |
|---|---|
| `feature/interactive-mode` at `adf789e` | Current branch/HEAD; compact NATS interaction panel committed here |
| `main`, `origin/main`, `origin/HEAD`, `feature/focus-cards`, `v0.2.0-settings` at `0df54e1` | Stable HUD + preferences checkpoint |
| `feature/settings` at `1da4d2d` | Persistent preferences implementation |
| `archive/focus-lag-experiment` at `f5f8160` | Abandoned desktop-lagging experiment; do not merge/copy |
| `b37dcc2` | Milestone 1: explicit interaction proof with whole HUD in `Main.uiGroup` |
| `v0.1.0-desktop` at `8be2234` | Full desktop layout checkpoint |
| `9508c48` | Replaced unsupported `St.ProgressBar` |
| `2c7adc1` | Registered HUD widgets with GObject |
| `8d9cf8a` | Added safe application launcher utilities |
| `96efcc3` | Added CPU and memory telemetry module |

Agent-host bookkeeping commits also appear in the all-refs history; they are not product milestones. Do not rewrite history or move branches.

### Current uncommitted work

At the last inspected status:

```text
 M extension.js
 M stylesheet.css
?? .vscode/
?? docs/DEV_NOTES.md
```

`git diff --stat` then showed 591 changed lines in `extension.js` and 71 in `stylesheet.css`. These are pre-existing worktree changes relative to `adf789e`, not changes made by this handoff task. `.vscode/settings.json` and `docs/DEV_NOTES.md` were untracked. Recheck status before editing because status may have changed; never discard or overwrite unrelated/user work.

## Settings and preferences

`metadata.json` targets Shell 50 and names schema `org.gnome.shell.extensions.nats-hud`. The schema currently defines:

- `card-opacity`: double, default 0.52, range 0.20–0.90
- `update-interval`: integer seconds, default 1, range 1–10
- visibility booleans for CPU, memory, system, network, storage, power, activity, actions
- `toggle-interactive-mode`: string array, default Super+Shift+N

`prefs.js` uses Adw preferences and `Gio.Settings` to persist values. The extension listens for setting changes, applies card opacity/visibility, and restarts its existing timer only when the update interval changes. Preserve schema types, ranges, and prefs bindings if changing settings.

## NATS Comms roadmap — FUTURE

NATS Comms is a later feature, not part of the current memory/section work.

- It should eventually replace the reserved POWER card, not consume the Quick Actions area.
- Quick Actions remain separate and continue to launch local applications.
- Start with mock/local JSON at `~/.local/share/nats-assistant/comms.json`; do not begin with a network integration.
- Assistant reasoning, provider credentials, conversation processing, and channel integration belong in a separate assistant service outside GNOME Shell. GNOME Shell should remain a thin, low-risk presentation client and must not host long-running assistant logic.
- The eventual service should provide structured conversation states (for example unread, active, waiting, resolved), priorities, safe summaries, and explicit user-approved actions.
- Keep the collapsed HUD privacy-safe: show minimal metadata/summary by default, not full sensitive message bodies. Make detailed content an explicit user action and avoid leaking private content onto the desktop.
- Draft replies may be prepared, but require user approval before sending. Never send autonomously.
- Any eventual WhatsApp integration must use safe, official, authorized integration paths. Do not automate WhatsApp Web, scrape sessions, or bypass platform controls.
- Define local service protocol, data retention, permission boundaries, and threat model before implementation. No service, WhatsApp integration, or assistant connection exists in the current code.

## Future focused-section roadmap — FUTURE

Only CONTROL, CPU, and a Memory view are present in current source. Continue one section at a time after fresh-session stability is established.

1. **Network:** No focused page yet. Existing snapshot has interface name and download/upload byte rates. A future page should consume the existing snapshot and keep routing/logging behavior coherent; do not add another telemetry sampler.
2. **Storage:** No focused page yet. Existing telemetry describes root filesystem capacity, not disk I/O. Keep this semantic distinction clear; do not imply throughput unless actual block I/O data is added intentionally.
3. **System:** No focused page yet. Existing snapshot has uptime and load averages; existing main HUD system card already uses them.
4. **Activity:** No focused page yet. CPU and network history arrays already feed main-HUD sparklines. Reuse existing history only; do not add a duplicate history sampler.
5. **Comms:** Placeholder only; follow the separate-service/privacy roadmap above.

Use current section identifiers and a small, explicit section dispatch; do not introduce a general-purpose router/framework. Preserve CONTROL as the route back from each focused page unless navigation requirements are explicitly changed.

## Exact development rules

- Do not rebuild the project.
- Do not touch `main`, merge branches, or commit without explicit user authorization.
- Do not change the two-layer architecture.
- Do not move the whole HUD into `Main.uiGroup`.
- Do not introduce full-screen reactive actors, transparent hit targets, or any archived focus experiment.
- Do not add animations, CSS transitions, timers, telemetry objects, or polling loops unless the user explicitly changes scope.
- Preserve one telemetry lifecycle and reuse `_lastSnapshot`.
- Inspect current snapshot fields before rendering a metric; do not invent telemetry fields or imply unavailable values are implemented.
- Keep unsupported sections as placeholder logs; do not render empty focused pages.
- Keep launcher execution in `src/launcher.js` and use argv-based `Gio.Subprocess`.
- Use GObject registration for custom St subclasses; compose supported `St.Widget` elements for bars.
- Update existing actors on telemetry refresh. Rebuild only when a user explicitly navigates and clear section actor references when content is replaced.
- Preserve unrelated dirty worktree changes. Read current diffs before editing files that are already modified.
- Prefer small targeted validation. Do not log out/restart GNOME or physically reload the extension unless the user explicitly asks.
- Distinguish implemented code, static checks, physical verification, and pending runtime validation in all handoffs.
- Do not claim a bug is fixed permanently until the failure path is physically exercised after a fresh GNOME session.

## Current next milestone

**First priority — PENDING PHYSICAL VERIFICATION:** After the user is able to start a fresh GNOME session, check extension activation and the journal for the `get_transition` null-actor error and any stale `St.ProgressBar` error. Physically exercise open/close, CONTROL → CPU → BACK, CONTROL → MEMORY → BACK, repeating cycles, and disable/re-enable where safe. Do not claim those focused pages are physically validated before doing so.

**Then — targeted Memory correctness follow-up:** Inspect current uncommitted diff and make the active-view update dispatch work for both CPU and Memory, still using the same snapshot and timer. Decide whether to leave cache/swap as unavailable or add telemetry fields only if authorized and needed. This follow-up is not a license for unrelated features.

Only after those checks should the next focused section be selected. Network is a natural next implementation candidate, but no new major section should start until the above work and current milestone are reconciled with the user.

## Next Agent Startup Checklist

1. Read this file fully.
2. Run `git status`.
3. Confirm current branch.
4. Inspect uncommitted diff.
5. Do not rebuild the architecture.
6. Preserve backgroundGroup/uiGroup separation.
7. Preserve one telemetry lifecycle.
8. Do not resurrect transparent fullscreen hit targets.
9. Do not assume uncommitted changes are physically verified.
10. Continue from the CURRENT NEXT MILESTONE documented here.
