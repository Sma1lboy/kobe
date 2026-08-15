# PTY host freeze/restore — surviving a host restart

> Design note (2026-08-15). The problem: the standalone PTY host
> (`kobe-daemon/src/daemon/pty-server.ts`) keeps every session's metadata and
> scrollback ring **in memory only**, so while a `rove daemon restart` is
> harmless (separate process), the host process itself ending — crash,
> SIGTERM, machine reboot — took the whole work scene with it. The next host
> came up empty: `pty.list` showed nothing, a reattach spawned a blank
> shell/engine, and only the engine's own conversation file was recoverable.

## Decision

Freeze every session to disk, restore lazily, respawn on attach. No attempt
to keep processes alive across a host death (that needs fd-passing/CRIU-class
tricks — rejected as not worth it, same call as the original daemon doc).

- **Freeze** (`pty-freeze-store.ts`): one JSON file per session under
  `<home>/.kobe/pty-sessions/<urlencoded-key>.json` — key, cwd, launch
  command, size, title, monotonic byte offset, exit record, and the ring
  buffer (base64, already capped at ~512 KiB). Written at most once per 5s
  per session while streaming (crash-loss bound), immediately on exit, and
  for every session during `shutdown()`. Atomic tmp+rename; every operation
  is best-effort — a freeze hiccup must never take the terminal down.
- **Restore**: at boot (before listen) the host thaws each record into a
  dead session marked `restored`, ring intact. It stays a corpse — zero
  live sessions still idle-exit, and nothing spawns engines the user isn't
  looking at (a boot must not fan out 20 claude sessions' worth of quota).
- **Respawn-on-open** (`pty-host.ts`): opening a `restored` session restarts
  the child **in place** — the old ring is replayed first, live output
  appends after it, `totalBytes` keeps counting. The caller's spawn spec
  wins when it carries a command: the TUI's dead-reattach already passes
  its `--resume <sessionId>` launch (`engineTabArgv`), so engine
  conversation resume composes with scrollback restore with no TUI change.
  A failed respawn clears `restored` and degrades to the ordinary view-only
  corpse behavior (the one-shot resume guard TUI-side stays the backstop).
- **Forgetting**: explicit `pty.kill` (tab close, archive sweep) drops the
  record — an intentional end is not a restart casualty. `rove reset`'s
  graceful `daemon.stop` wipes the whole store ("starts fresh"); a bare
  SIGTERM/crash/reboot keeps it.

## What changed outside the host

- `pty.open` gained `respawned?: boolean` (distinct from `created`): the
  respawned launch DID consume the caller's spec, so a prompt embedded in
  its argv must not be pasted a second time (`pty-delivery.ts`).
- `pty.list` rows gained `restored?: boolean`; headless delivery
  (`deliverHostedPrompt`) no longer kills a restored canonical corpse before
  opening — the open respawns it, keeping scrollback.
- CLI-started sessions (`rove api add`/`send`) now pin their conversation id
  up front (`withClaudeSessionId`, the TUI's existing contract) and record
  `sessionId` + `spawned` in the persisted tab snapshot once the session
  provably started — so a headless task's engine conversation is resumable
  after a host restart exactly like a TUI-spawned tab. `send` itself still
  starts a fresh conversation (a `--resume` of a never-conversed id errors
  hard; the snapshot only records ids of sessions that started).

## Boundaries kept

- The host stays vendor-neutral: it persists and re-runs launch lines; the
  `--resume` decision lives in the engine-aware layers (TUI argv builder).
- The warm spare (`::spare`) never freezes (internal key, same rule as the
  exit store).
- `pty-exits.json` (death diagnostics) and the freeze store stay separate:
  one answers "how did it die", the other "put the scene back".

## Tests

- `test/daemon/pty-freeze-store.test.ts` — record round-trip, corruption
  tolerance, cap trim, drop/clear semantics.
- `test/daemon/pty-host-freeze.test.ts` — fake-driver host semantics:
  throttle, respawn-in-place, spec-wins, failed-respawn degrade, kill-drops,
  shutdown-keeps.
- `test/daemon/pty-server-restart.test.ts` — real socket server across a
  restart: corpse listed, respawn on open, `daemon.stop` wipes.
- `test/render/pty-freeze.test.ts` — real `/bin/cat` PTY + real file store,
  end to end.
