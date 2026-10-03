# Telemetry: CPU and Memory

- Linux exposes cumulative CPU time counters in `/proc/stat`. CPU usage is calculated from the difference between two samples, so the first sample has no percentage yet.
- `/proc/stat` also reports cumulative counters for each `cpuN` core. Compare each core with its own previous counters; a newly appearing core has no usage percentage until it has two samples.
- `/proc/meminfo` reports `MemTotal` and `MemAvailable` in KiB. `MemAvailable` estimates memory the system can allocate without swapping; it is more useful than `MemFree` for estimating memory pressure.
- `Gio.File.load_contents()` reads these procfs files from GJS. `TextDecoder` converts the returned bytes to text without Node.js APIs.
- CPU temperatures are optional sysfs data: thermal-zone `temp` files are preferred, with hwmon `temp*_input` as a fallback. These readings are typically millidegrees Celsius, and some systems expose no readable sensor.
- `/proc/uptime` provides elapsed uptime in seconds. The first three fields of `/proc/loadavg` are the 1-, 5-, and 15-minute load averages.
- CPU usage is the fraction of processor time spent non-idle over a sampling interval. Load average is the average number of runnable or uninterruptible tasks, not a CPU percentage; interpret it in relation to available CPU cores.
- `/proc/net/dev` exposes cumulative receive/transmit byte counters per interface. A rate is the counter delta divided by elapsed time, so the first sample establishes a baseline and rates become meaningful only after a later sample.
- Gio filesystem metadata provides root filesystem total/free capacity; used bytes are derived from those values. Capacity describes a filesystem, while `/proc/diskstats` describes block-device I/O, which is not necessarily attributable to `/` without mapping the mounted filesystem to its device.

# Formatting: Data and Presentation

- Keep telemetry responsible for collecting raw measurements, formatters responsible for converting values into readable text, and widgets responsible for displaying that text. This makes formatting independently testable and reusable without system access or GNOME UI dependencies.
- Return a consistent placeholder for unavailable numeric values, and clamp bounded visual indicators such as percentages and text bars before rendering them.

# Reusable UI Components

- Small reusable St components give cards, metric values, progress indicators, sparklines, and section headings a consistent structure while keeping their presentation in `stylesheet.css`.
- GObject-backed actors such as `St.BoxLayout` and `St.Label` require JavaScript subclasses to be registered with `GObject.registerClass()` before they can be instantiated; registration assigns each class a GType understood by GNOME Shell.
- Verify GNOME Shell APIs against the actual target runtime: an API may be documented or available in another version but missing as a constructible widget here. When a widget is unavailable, composing ordinary St actors can provide the needed behavior with fewer runtime assumptions.
- Update existing actors when telemetry refreshes instead of recreating them. This preserves layout and actor state, avoids repeated allocation and destruction, and keeps refresh work lightweight.
- Keep UI components separate from telemetry: widgets display values they receive, while telemetry alone is responsible for collecting system data.

## GNOME Shell CSS

- GNOME Shell styles use a GTK/St CSS subset, not a browser engine. Validate selectors and transitions in the running Shell, and do not rely on browser-only features such as `backdrop-filter`; translucent actor backgrounds provide a compatible glass effect.

# Process Launching

- `Gio.Subprocess` launches a child process without blocking the Shell, and its asynchronous wait API can report unsuccessful exits.
- Pass a validated argv array directly to the process API. Each argument remains a distinct value, so spaces or shell metacharacters are not interpreted as command syntax as they would be in a constructed shell string.
- Keep application launching outside UI components. Widgets can request an action while the launcher owns process creation, validation, and error reporting.

# HUD Orchestration and Lifecycle

- `extension.js` coordinates the modules: it creates telemetry, builds the reusable widget tree, formats snapshots, and sends actions to the launcher without taking over those modules' responsibilities.
- GNOME Shell calls `enable()` when activating an extension and `disable()` when deactivating it. Create actors, telemetry state, and timeout sources in `enable()`; remove the GLib source and destroy the actor tree in `disable()` so resources do not outlive the extension.
- A GLib timeout returns a source ID that must be removed during teardown. Keep references to the existing widgets and update their values on each tick instead of rebuilding the actor hierarchy.
- Build one per-core row for each `cpuN` identifier and retain it in a map. On each snapshot, look up that row and update its labels and progress fill; separating actor lifetime from sample lifetime avoids rebuilding the core grid every second.
