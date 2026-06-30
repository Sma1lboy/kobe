---
"@sma1lboy/kobe": patch
---

fix: stop `invalid option: @kobe_zen` tmux banner on session-option polls

`getSessionOption` ran `show-options -v` without `-q`, so reading an unset
session-scoped user option (`@kobe_zen`, `@kobe_worktree`, …) made tmux error
with `invalid option: …` and the capturing wrapper surfaced it as a banner on
every zen/task-enter poll. Added the load-bearing `-q` (matching
`getServerOption`) so unset options resolve to `""` with exit 0 instead.
