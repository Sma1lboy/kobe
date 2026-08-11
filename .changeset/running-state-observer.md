---
"@sma1lboy/kobe": patch
---

Sidebar running dots now track ground truth instead of only the hook event stream (issues #11/#16). The daemon runs an activity observer over the pty host's inventory: a PTY output heartbeat (output/title frozen for 30s ⇒ not working), an engine-owned title verdict (claude's ⠂/⠐ working frames vs its resting ✳; codex's braille), and a ~60s foreground-walk reconciler that corrects stale hook claims — with an immediate first pass so a daemon restart re-seeds busy sessions' dots in seconds instead of at the next turn boundary. The sidebar also distinguishes "the daemon doesn't know" (a dotted ◌) from known-idle (○), and known-idle facts replay to late subscribers.
