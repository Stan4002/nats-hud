# Bugs and Fixes

## Custom St actors failed to construct

- **Symptom:** GNOME Shell reported `Tried to construct an object without a GType` when creating `GlassCard`.
- **Cause:** JavaScript subclasses of GObject-backed St actors were not registered as GTypes.
- **Fix:** Register each custom actor class with `GObject.registerClass()` and give it a unique GType name.
- **Lesson:** GObject-backed classes need registration before GJS can instantiate their subclasses.

## ProgressMetric used an unavailable St.ProgressBar

- **Symptom:** GNOME Shell reported `St.ProgressBar is not a constructor` while creating `ProgressMetric`.
- **Cause:** `St.ProgressBar` is not a constructible widget in this GNOME Shell 50 runtime.
- **Fix:** Build the indicator from persistent `St.Widget` track and fill actors, resizing the fill on updates and track allocation changes.
- **Lesson:** Confirm widget constructors in the target Shell runtime; simple St actors are a reliable basis for small custom controls.
- **Verification note:** Syntax and diagnostics pass, but this Shell session still reports its stored ProgressBar error after disable/enable and emitted no new trace. A fresh Shell process is needed to confirm the corrected module reaches `ACTIVE`.
