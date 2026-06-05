---
"@sma1lboy/kobe": patch
---

Tasks pane can now reorder regular task rows in-place: press `Shift+M` on a task, use `j` / `k` to move it, and press `Enter` or `Esc` to leave move mode. The order is persisted through the daemon so every open Tasks pane follows the same list.

Task activity now lives in the row's leading status slot: running turns use the animated spinner, while approval-needed, rate-limited, completed, and error states use icons in that same position instead of adding a trailing text chip.
