---
"@sma1lboy/kobe": patch
---

React port of the Ops pane + preview window behind `KOBE_REACT=1` (issue #15, G3): `kobe ops` and `kobe ops --preview` now route to `src/tui-react/ops/` when the flag is set, mounting the already-ported React FileTree. The Solid host was split under the file-size cap, extracting the framework-free poll loops (`tui/ops/activity-monitor.ts`), shell actions + concrete tmux IO (`tui/ops/host-io.ts`), and the preview data/syntax mapping (`preview-core.ts`/`preview-syntax.ts`) shared verbatim by both hosts. `RemoteOrchestrator` gains a `transcriptActivityStore()` external-store twin of the `transcript.activity` signal for React consumers, plus a `dev:mock-react-ops` render-proof script.
