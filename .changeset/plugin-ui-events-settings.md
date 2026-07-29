---
"@sma1lboy/kobe": patch
---

Plugin surface grows three ways: `[[settings]]` schemas render as per-plugin editors in Settings → Plugins (values stored in the plugin's config `.env`); `[[file_handlers]]` route Files-pane opens to a plugin action by filename pattern (mp4 → the video plugin); and UI moments fire as plugin events — `file.will-open`, `file.opened` (with via), `task.opened`, `project.opened` — over the new `ui.reportEvent` path.
