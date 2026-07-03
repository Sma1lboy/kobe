---
"@sma1lboy/kobe": patch
---

fix: web memory leaks — SSE disconnect backstop + issue-snapshot cache sweep

- SSE streams (daemon web transport + bridge) now tear down on the request's abort signal and on a failed heartbeat write, not only via `ReadableStream.cancel()`. A half-open disconnect (laptop sleep, dropped Wi-Fi, killed browser) could previously leave a phantom web client that kept `guiCount > 0` forever — pinning every collector (git status / transcript / PR polls) alive for a browser that was gone and preventing the daemon from ever lazily stopping.
- The issue-snapshot mirrors (bridge `DaemonLink` and the SPA store) are now swept against the live task set on every `task.snapshot`, like the engine-state mirror beside them. Alias keys used to accumulate one per worktree path forever as tasks were created and deleted.
- Split the `/api/settings` route block out of `web-server.ts` / `bridge.ts` into `web-settings.ts` / `bridge-settings.ts` (file-size cap; no behavior change).
