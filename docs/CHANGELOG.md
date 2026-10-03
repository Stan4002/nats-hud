# Changelog

## CPU detail integration

- Added CPU temperature and compact per-core usage indicators to the CPU card.
- Added uptime and 1/5/15-minute load averages to the system section.
- Reused per-core actors across telemetry refreshes.

## Visual polish pass 1

- Refined the HUD's spacing, typography, glass surfaces, progress indicators, and action controls.
- Added restrained cyan CPU and violet memory accents with subtle hover transitions.

## 2026-10-03 - Modular HUD integration

- Replaced the placeholder HUD with a modular dashboard orchestrated by `extension.js`.
- Added live CPU and memory cards, a rolling CPU sparkline, and quick-launch actions.
- Added one-second telemetry updates with actor reuse and lifecycle cleanup.
