---
"@sma1lboy/kobe": patch
---

Exiting the engine CLI inside a terminal tab is now an allowed action, not a dead end: the tab degrades in place to your shell in the same worktree (keeping its title and identity) instead of freezing behind the exit banner. A degraded shell tab closes itself on its next exit; the last tab still keeps the banner + F5 recovery. Internally `TerminalTab` became a discriminated union (engine | command) so the illegal tab shapes can't be represented.
