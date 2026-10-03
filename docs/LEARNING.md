# Telemetry: CPU and Memory

- Linux exposes cumulative CPU time counters in `/proc/stat`. CPU usage is calculated from the difference between two samples, so the first sample has no percentage yet.
- `/proc/meminfo` reports `MemTotal` and `MemAvailable` in KiB. `MemAvailable` estimates memory the system can allocate without swapping; it is more useful than `MemFree` for estimating memory pressure.
- `Gio.File.load_contents()` reads these procfs files from GJS. `TextDecoder` converts the returned bytes to text without Node.js APIs.

# Formatting: Data and Presentation

- Keep telemetry responsible for collecting raw measurements, formatters responsible for converting values into readable text, and widgets responsible for displaying that text. This makes formatting independently testable and reusable without system access or GNOME UI dependencies.
- Return a consistent placeholder for unavailable numeric values, and clamp bounded visual indicators such as percentages and text bars before rendering them.
