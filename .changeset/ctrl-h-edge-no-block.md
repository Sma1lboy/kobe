---
"@sma1lboy/kobe": patch
---

Fix (tmux handover): the ctrl+h left-edge fallback now skips the CLI spawn entirely when the active pane already IS the Tasks rail (`@kobe_role=tasks` format gate) — the muscle-memory spam case spawned a background `kobe layout tasks-restore` per press (backgrounding shipped in 0.7.61; this removes the spawn itself). The real restore cases — rail hidden or crashed, where the left-edge pane is the engine/shell — still fire. Verified live on tmux 3.6.
