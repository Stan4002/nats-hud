# Telemetry: CPU and Memory

- Linux exposes cumulative CPU time counters in `/proc/stat`. CPU usage is calculated from the difference between two samples, so the first sample has no percentage yet.
- `/proc/meminfo` reports `MemTotal` and `MemAvailable` in KiB. `MemAvailable` estimates memory the system can allocate without swapping; it is more useful than `MemFree` for estimating memory pressure.
- `Gio.File.load_contents()` reads these procfs files from GJS. `TextDecoder` converts the returned bytes to text without Node.js APIs.

# Formatting: Data and Presentation

- Keep telemetry responsible for collecting raw measurements, formatters responsible for converting values into readable text, and widgets responsible for displaying that text. This makes formatting independently testable and reusable without system access or GNOME UI dependencies.
- Return a consistent placeholder for unavailable numeric values, and clamp bounded visual indicators such as percentages and text bars before rendering them.

# Reusable UI Components

- Small reusable St components give cards, metric values, progress indicators, sparklines, and section headings a consistent structure while keeping their presentation in `stylesheet.css`.
- GObject-backed actors such as `St.BoxLayout` and `St.Label` require JavaScript subclasses to be registered with `GObject.registerClass()` before they can be instantiated; registration assigns each class a GType understood by GNOME Shell.
- Update existing actors when telemetry refreshes instead of recreating them. This preserves layout and actor state, avoids repeated allocation and destruction, and keeps refresh work lightweight.
- Keep UI components separate from telemetry: widgets display values they receive, while telemetry alone is responsible for collecting system data.

# Process Launching

- `Gio.Subprocess` launches a child process without blocking the Shell, and its asynchronous wait API can report unsuccessful exits.
- Pass a validated argv array directly to the process API. Each argument remains a distinct value, so spaces or shell metacharacters are not interpreted as command syntax as they would be in a constructed shell string.
- Keep application launching outside UI components. Widgets can request an action while the launcher owns process creation, validation, and error reporting.

# HUD Orchestration and Lifecycle

- `extension.js` coordinates the modules: it creates telemetry, builds the reusable widget tree, formats snapshots, and sends actions to the launcher without taking over those modules' responsibilities.
- GNOME Shell calls `enable()` when activating an extension and `disable()` when deactivating it. Create actors, telemetry state, and timeout sources in `enable()`; remove the GLib source and destroy the actor tree in `disable()` so resources do not outlive the extension.
- A GLib timeout returns a source ID that must be removed during teardown. Keep references to the existing widgets and update their values on each tick instead of rebuilding the actor hierarchy.
