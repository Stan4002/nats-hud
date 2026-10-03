# Telemetry: CPU and Memory

- Linux exposes cumulative CPU time counters in `/proc/stat`. CPU usage is calculated from the difference between two samples, so the first sample has no percentage yet.
- `/proc/meminfo` reports `MemTotal` and `MemAvailable` in KiB. `MemAvailable` estimates memory the system can allocate without swapping; it is more useful than `MemFree` for estimating memory pressure.
- `Gio.File.load_contents()` reads these procfs files from GJS. `TextDecoder` converts the returned bytes to text without Node.js APIs.
