---
"@sma1lboy/kobe": patch
---

Memory-leak audit, round two — five more long-session leaks fixed: sidebar rows now reconcile by identity so every task switch no longer recreates every row's renderables in every open Tasks pane; the engine-state map prunes entries for deleted tasks; a failed pane-side prefs connection no longer leaves an orphaned reconnect loop running forever; pending daemon RPCs are swept on forced reconnects instead of being retained (and awaited) forever; and auto-titles / Copilot history no longer pin multi-MB message buffers via substring retention.
