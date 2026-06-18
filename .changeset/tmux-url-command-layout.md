---
"@sma1lboy/kobe": patch
---

Internal: the tmux URL opener command now lives behind the tested Session Layout module instead of being assembled inline in the imperative session applier. The command shape, fzf fallback, opener, and tmux socket quoting are covered by the existing tmux layout test surface.
