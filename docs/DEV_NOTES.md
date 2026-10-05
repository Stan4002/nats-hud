# NATS HUD Dev Notes

This document captures the current state of the NATS HUD GNOME Shell extension for the `feature/interactive-mode` branch. It summarizes architecture, refactors, telemetry flow, runtime concerns, and the current validation status.

## Scope and constraints

- Do not rebuild the project.
- Do not touch `main`.
- Do not merge branches.
- Do not commit automatically.
- Keep the architecture stable while iterating on the interactive panel.

## NATS HUD / NATS Assistant boundary

**NATS HUD** is the provider-agnostic GNOME Shell presentation layer. It is responsible for telemetry visualization, assistant summaries, task/calendar/comms presentation, focused system views, and dispatching assistant intents. `+ TASK` and `+ CAPTURE` currently dispatch logged intents only; they do not write tasks or communicate with a service.

**NATS Assistant** is a future, separate local service. It will own tasks and handle calendar sync, comms sync, authentication, persistence, normalization, reminders, classification, and drafts. Do not implement this backend in the HUD or couple the HUD to any provider.

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
