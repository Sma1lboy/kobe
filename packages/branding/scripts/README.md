# quicklook replay

The `quicklook-replay` Remotion composition renders the checked-in terminal
capture at `src/quicklook/frames.json` — the README demo video. It replays
the storyboard in `src/quicklook/quicklook.replay.json` through the real
PureTUI Workspace Host and Hosted PTY runtime: create a task, prompt it,
`kobe api fan-out` two more attempts from a shell tab, open one attempt,
review its diff vs base, and `kobe api land` the winner.

## Regenerate

```bash
bun --filter @sma1lboy/kobe build          # the capture drives the BUILT cli
cd packages/branding
KOBE_REPLAY_CLAUDE_COMMAND="$PWD/scripts/fixtures/claude-demo" \
bun run capture:puretui --keep-demo-root
bun x remotion render src/index.ts quicklook-replay out/quicklook-replay.mp4
cp out/quicklook-replay.mp4 ../../docs/assets/demo.mp4
# the inline README GIF, at the same 960×540 / 10fps as the checked-in asset
bun x remotion render src/index.ts quicklook-replay out/quicklook-replay.gif \
  --codec=gif --scale=0.75 --every-nth-frame=3
cp out/quicklook-replay.gif ../../docs/assets/demo.gif
```

- `KOBE_REPLAY_CLAUDE_COMMAND` points the claude engine at
  `scripts/fixtures/claude-demo`, a stub that does REAL work in the task
  worktree (rewrites `src/session.ts`, commits) so every frame is the
  product's own rendering with no real-engine auth/quota/nondeterminism.
  Without it the capture launches the installed Claude binary from `PATH`.
- **Build first.** The sidecar prefers `packages/kobe/dist/cli/index.js` and
  only falls back to source. Prompt codas kobe writes into a session embed
  `kobeCliInvocation()`, which renders the bare `kobe` a user actually sees
  only from a `.js` entry — captured from source it bakes the capture host's
  absolute bun + repo paths into the recording.
- The shell prompt is pinned by the spec (`capture.shellPrompt`), exported as
  `PS1` with `SHELL=/bin/sh`, so the `shellPrompt` wait works on any host. Do
  NOT rely on the operator's login shell: a POSIX `sh` honours an inherited
  PS1 and reads no rc file that would overwrite it, while dash's bare `$` and
  bash's `bash-5.x$` differ per machine.
- The typed `kobe` in shell tabs resolves through `bun run`'s
  `node_modules/.bin` PATH prepend — put a `kobe` shim there
  (`packages/branding/node_modules/.bin/kobe` →
  `exec bun <repo>/packages/kobe/dist/cli/index.js "$@"`) so the shell beats
  drive THIS checkout's built CLI, not a stale global install. The shim lives
  in gitignored `node_modules` and must be re-created after a fresh install.
- `scripts/fixtures/claude-demo` is `#!/bin/sh` and must stay POSIX: use
  octal (`\342\200\272`) escapes, never `\xHH`, which dash's `printf` prints
  literally — the `ready ›` wait marker silently stops matching off macOS.
- Kobe state and the fixture repository stay isolated under a throwaway
  `.capture-home-puretui-*` demo root (retained for review; the CLI prints
  the path). Engine subprocesses keep the host's normal home directory.

## Storyboard discipline

- `beats[].at` are NOMINAL spacers: the gap `(at - previous at)` is slept in
  full on top of however long each beat really takes, so keep gaps small and
  let waits carry the pacing. `capture.seconds` belongs to that nominal
  timeline (it only pads the tail) — never raise it to the real duration.
- Wait patterns must be UNIQUE to the state they wait for. `"New task"` also
  matches the sidebar's own `+ New task` button, so it returned instantly and
  the flow typed into a dialog that had never opened; `"from branch"` is a
  dialog-only label. A wait that can pass early fails much later and
  elsewhere.
- The sidebar owns the bare letters (`n`), and a fresh boot does not focus it,
  so a flow that opens a dialog needs `focusPaneBeforeOpen` — which sends the
  `ctrl+a` `h` prefix sequence. Not `ctrl+q`: that focuses the sidebar but
  QUITS when the sidebar already has it.
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
