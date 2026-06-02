---
"@sma1lboy/kobe": patch
---

Multi-client window sizing: enable tmux `aggressive-resize` so each chat-tab window tracks the client actually viewing it. Before, a small terminal attached anywhere in a task session dragged every window — including the one a larger terminal was looking at — down to the smallest client's size, which then squeezed the fixed-width Tasks pane against a too-narrow window. Now each window sizes to its own current viewer. (Two clients on the *same* window still share one grid and the larger is letterboxed — a tmux limit that needs per-client sessions to lift.)
