---
"@sma1lboy/kobe": patch
---

Actually show the cross-task attention toasts in the main app. The bottom-right toast overlay was only mounted in the standalone `kobe tasks` pane, so in the workspace host the notify calls fired (and OSC 9 desktop notifications went out) but no visual toast ever appeared. Mount `ToastOverlay` in the workspace host.
