---
"@sma1lboy/kobe": patch
---

The web dashboard's desktop notifications now also cover PR transitions: CI checks flipping red or green, a PR becoming ready to merge, and a merge landing each ping you (same opt-in, permission, and page-hidden gates as the existing engine attention notifications; clicking jumps to the task). Transitions are rising-edge diffs of consecutive task snapshots, so a page load or a PR's first appearance never fires a notification blast.
