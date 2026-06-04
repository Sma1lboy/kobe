---
"@sma1lboy/kobe": patch
---

Two fixes.

- **Per-task activity hooks now actually install for existing tasks.** They were only written on the worktree-CREATE path (`ensureWorktree`), but entering an already-materialized task skips `ensureWorktree` — so every pre-existing task never got the Claude Code hooks and the event-driven badges silently did nothing for them. The install moved to `ensureSession` (the single point every session build/reuse/rebuild passes through), so the hooks land on disk on every enter. A task whose engine is already running picks them up on its next engine launch (a rebuild, a vendor switch, or a new Ctrl+T chat-tab).

- **The file-tree `e` editor now follows the standard `$VISUAL` / `$EDITOR`.** The default was a hardcoded `vim` that ignored your environment entirely. The new default kind is `auto`: it honours `$VISUAL` / `$EDITOR`, and if neither is set, auto-detects the first installed of nvim → vim → emacs → nano. `nvim` and `emacs` are now explicit choices too (alongside vim / nano / custom), all selectable from Settings. (Note: `e` opens the editor; `enter` still opens kobe's read-only preview — those are deliberately separate.)
