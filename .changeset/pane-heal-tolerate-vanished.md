---
"@sma1lboy/kobe": patch
---

fix: pane heal tolerates a pane that vanished mid-heal

The workspace/version heal reads a pane snapshot, then runs one batched `respawn-pane … ; resize-pane …` tmux sequence against those ids. tmux halts a `cmd ; cmd …` sequence on the first failure, so a pane closed (tab close / task delete) between the snapshot and execution made its `respawn-pane -t <gone>` error and silently abort the heal of every later pane that tick. The heal now re-lists panes immediately before the batch and drops commands for any pane that no longer exists, so one vanished pane can no longer cancel the heal of the others. Only paid when the heal has work to do — a healthy switch (no commands) keeps its exact behavior and spawn count.
