# Bugs and Fixes

## Custom St actors failed to construct

- **Symptom:** GNOME Shell reported `Tried to construct an object without a GType` when creating `GlassCard`.
- **Cause:** JavaScript subclasses of GObject-backed St actors were not registered as GTypes.
- **Fix:** Register each custom actor class with `GObject.registerClass()` and give it a unique GType name.
- **Lesson:** GObject-backed classes need registration before GJS can instantiate their subclasses.
- **Verification note:** The current Shell session retains the original extension error after disable/enable; its `ReloadExtension` method is unsupported. A fresh Shell session is still needed to confirm the corrected module reaches `ACTIVE`.
