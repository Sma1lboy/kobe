# quicklook replay

The `quicklook-replay` Remotion composition renders the checked-in terminal
capture at `src/quicklook/frames.json` — the README demo video. It replays
the storyboard in `src/quicklook/quicklook.replay.json` through the real
PureTUI Workspace Host and Hosted PTY runtime: create a task, prompt it,
`kobe api fan-out` two more attempts from a shell tab, open one attempt,
review its diff vs base, and `kobe api land` the winner.

## Regenerate

```bash
cd packages/branding
SHELL=/bin/sh \
KOBE_REPLAY_CLAUDE_COMMAND="$PWD/scripts/fixtures/claude-demo" \
bun run capture:puretui --keep-demo-root
bun x remotion render src/index.ts quicklook-replay out/quicklook-replay.mp4
cp out/quicklook-replay.mp4 ../../docs/assets/demo.mp4
```

- `KOBE_REPLAY_CLAUDE_COMMAND` points the claude engine at
  `scripts/fixtures/claude-demo`, a stub that does REAL work in the task
  worktree (rewrites `src/session.ts`, commits, files a worker report via
  `kobe api report`) so every frame is the product's own rendering with no
  real-engine auth/quota/nondeterminism. Without it the capture launches the
  installed Claude binary from `PATH`.
- `SHELL=/bin/sh` keeps shell tabs on a bland `sh-3.2$` prompt (the
  `shellPrompt` wait pattern) instead of the user's zsh setup.
- The typed `kobe` in shell tabs resolves through `bun run`'s
  `node_modules/.bin` PATH prepend — put a `kobe` shim there
  (`packages/branding/node_modules/.bin/kobe` →
  `exec bun --conditions=browser <repo>/packages/kobe/src/cli/index.ts "$@"`)
  so the shell beats drive THIS checkout's CLI, not a stale global install.
  The shim lives in gitignored `node_modules` and must be re-created after a
  fresh install.
- Kobe state and the fixture repository stay isolated under a throwaway
  `.capture-home-puretui-*` demo root (retained for review; the CLI prints
  the path). Engine subprocesses keep the host's normal home directory.

## Storyboard discipline

- `beats[].at` are NOMINAL spacers: the gap `(at - previous at)` is slept in
  full on top of however long each beat really takes, so keep gaps small and
  let waits carry the pacing.
- `stages[]` camera windows are REAL capture-time seconds tuned to the
  checked-in `frames.json`. After any recapture, re-derive them from the new
  frame timestamps (scan the frames for milestone strings) — and while
  iterating, swap in coarse stages (`0 → capture-end`) so pre-capture spec
  validation (which only knows `capture.seconds`) passes.
- Wait patterns match the SERIALIZED snapshot, which carries SGR codes at
  every style change — a pattern must live inside one uniformly-styled run
  (the stub prints `ready ›` unstyled for exactly this reason) and must not
  span a wrapped line.

Camera and framing logic lives in `src/quicklook/QuickLookReplay.tsx`; ANSI
parsing lives in `src/quicklook/ansi.ts`.
