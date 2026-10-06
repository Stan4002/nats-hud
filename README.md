# NATS HUD

NATS HUD is a GNOME Shell extension that acts as the visual desktop interface for the NATS personal assistant ecosystem.

It combines live system telemetry, daily context, task management, calendar information, assistant controls, and quick actions inside a compact heads-up display designed for Linux desktops.

The HUD is intentionally kept separate from the NATS Assistant backend so that presentation, persistence, providers, AI models, and future integrations can evolve independently.

---

## Overview

NATS HUD provides a persistent desktop interface for:

- CPU monitoring
- Memory monitoring
- Network activity
- Storage usage
- Activity/history visualization
- Task management
- Calendar information
- Daily schedule overview
- Assistant controls
- Quick application/system actions
- Future communications and AI integrations

The HUD communicates with the local NATS Assistant service over a localhost API.

```text
GNOME Shell
    |
    v
NATS HUD
    |
    | HTTP
    v
NATS Assistant
    |
    +-- Tasks
    +-- Calendar
    +-- SQLite
    +-- Google Calendar
    +-- Future model providers
    +-- Future communications providers
