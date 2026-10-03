# Changelog

## Preferences foundation

- Added persistent GSettings controls for card opacity, refresh interval, and dashboard sections.
- Added an Adwaita Preferences window with Appearance, Telemetry, and Interface sections.
- Connected saved settings to live card visibility, opacity, and polling behavior.

## Full desktop HUD layout

- Distributed telemetry cards across a responsive primary-monitor layout below the GNOME panel.
- Added neutral system/power and history areas with compact quick actions.
- Kept the root transparent and non-reactive so the wallpaper shows through and desktop input remains unobstructed.

## Network and storage telemetry

- Added active-interface download/upload rates and root filesystem capacity to the compact HUD.
- Added restrained network and storage cards without changing existing CPU, memory, or system metrics.

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
