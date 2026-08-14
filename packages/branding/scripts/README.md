# quicklook replay

> Historical replay pipeline only. Its checked-in capture predates the Rove
> identity, and the direct-PTY capture path below is not an accepted source for
> current product screenshots. Current visual assets must be captured through
> the fixed browser `/harness` path in `docs/HARNESS.md`; do not copy replay
> output into the README, docs, or landing page. The live equivalent of
> everything below now lives in `packages/kobe-web/e2e/hero-*.ts` (see
> [`docs/HARNESS.md` → README and docs assets](../../../docs/HARNESS.md)).

The `quicklook-replay` Remotion composition renders the checked-in terminal
capture at `src/quicklook/frames.json`. It replays
the storyboard in `src/quicklook/quicklook.replay.json` through the real
PureTUI Workspace Host and Hosted PTY runtime: create a task and prompt it,
start a SECOND task while the first agent is still mid-turn, let both work,
then visit each one's own branch and diff.

That is the pitch — one TUI holding many engine sessions, each isolated on its
own worktree and branch. It is deliberately NOT `fan-out` (many attempts at a
single prompt): that mode multiplies token spend for one deliverable, and it
is not what the demo should be selling. The two prompts touch DISJOINT files
so "agents never trample each other" is visible on screen rather than claimed.

The `quicklook-replay-4x` cut exists for archival replay work: a real turn
takes tens of seconds, so the 1x capture runs minutes.

## Historical regeneration (not shippable visual evidence)

```bash
bun --filter @sma1lboy/kobe build          # the capture drives the BUILT cli
cd packages/branding
KOBE_REPLAY_CLAUDE_COMMAND='claude --permission-mode acceptEdits --allowedTools "Bash(git *)"' \
bun run capture:puretui --keep-demo-root
bun x remotion render src/index.ts quicklook-replay-4x out/demo.mp4
bun x remotion render src/index.ts quicklook-replay-4x out/demo.gif \
  --codec=gif --scale=0.75 --every-nth-frame=3
```

- **The replay drives the REAL Claude Code**, not a stub: the demo has to show
  the product people actually install, down to its welcome box, tool calls and
  turn summaries. `scripts/fixtures/claude-demo` still exists for offline work
  on the pipeline itself, but a stub recording is not shippable — it renders a
  one-line fake banner, and Rove's live `ps`-walk labels its tab `shell`
  (correctly: the process IS a shell script), contradicting the pane beside it.
- `--permission-mode acceptEdits` covers file edits only. Both agents are asked
  to COMMIT, and a shell command still stops on "This command requires
  approval" — with nobody there to press 1 the turn simply never finishes and
  the branch stays empty. `--allowedTools "Bash(git *)"` is the narrow fix; do
  NOT reach for `bypassPermissions`, which would hand an unattended agent the
  operator's real `HOME`.
- Costs real quota and is nondeterministic by construction: two real sessions,
  each a real turn. Budget a few minutes per capture, and expect the transcript
  (and so the camera stages) to differ every run — one agent may commit while
  the other only edits, which the sidebar still shows as a diff badge.
- **The account identity is redacted** (`redactAccountIdentity` in
  `capture-core.ts`): Claude Code prints `<email>'s Organization` in its
  welcome box, and that would ship inside a public asset. Framing around it
  does not work — the camera falls back to a WIDE shot whenever a stage changes
  fewer than `camera.minChangedCells`, which is exactly the quiet
  both-agents-working beat. This is the one declared exception to "every frame
  is the product's own rendering".
- **Folder trust is inherited from an ancestor.** A demo root under a repo you
  have already trusted never shows Claude Code's "Is this a project you
  trust?" dialog; one under `/tmp` shows it in every worktree and the capture
  hangs. The default demo root sits inside this repo, so this is normally
  invisible — trust the repo root once if a capture stalls at boot.
- **Build first.** The sidecar prefers `packages/kobe/dist/cli/rove.js` and
  only falls back to source. Prompt codas Rove writes into a session embed
  the active CLI invocation, which renders the canonical bare `rove`
  only from a `.js` entry — captured from source it bakes the capture host's
  absolute bun + repo paths into the recording.
- The shell prompt is pinned by the spec (`capture.shellPrompt`), exported as
  `PS1` with `SHELL=/bin/sh`, so the `shellPrompt` wait works on any host. Do
  NOT rely on the operator's login shell: a POSIX `sh` honours an inherited
  PS1 and reads no rc file that would overwrite it, while dash's bare `$` and
  bash's `bash-5.x$` differ per machine.
- The typed `rove` in shell tabs resolves through `bun run`'s
  `node_modules/.bin` PATH prepend — put a `rove` shim there
  (`packages/branding/node_modules/.bin/rove` →
  `exec bun <repo>/packages/kobe/dist/cli/rove.js "$@"`) so the shell beats
  drive THIS checkout's built CLI, not a stale global install. The shim lives
  in gitignored `node_modules` and must be re-created after a fresh install.
- `scripts/fixtures/claude-demo` is `#!/bin/sh` and must stay POSIX: use
  octal (`\342\200\272`) escapes, never `\xHH`, which dash's `printf` prints
  literally — the `ready ›` wait marker silently stops matching off macOS.
- Rove state and the fixture repository stay isolated under a throwaway
  `.capture-home-puretui-*` demo root (retained for review; the CLI prints
  the path). Engine subprocesses keep the host's normal home directory.

## Storyboard discipline

- `beats[].at` are NOMINAL spacers: the gap `(at - previous at)` is slept in
  full on top of however long each beat really takes, so keep gaps small and
  let waits carry the pacing. `capture.seconds` belongs to that nominal
  timeline (it only pads the tail) — never raise it to the real duration.
- **A `sleep` beat polls at `capture.fps`.** It used to wait in one go and
  snapshot once at the end, which recorded a 75-second wait as a SINGLE frame:
  the delivered video froze for ~18 seconds at 4x, showing none of the work the
  wait existed for. Anything a beat waits through must be sampled, or it did
  not happen as far as the recording is concerned.
- `collapseIdleHolds` caps how long one frame may hang (10s) and shifts the
  rest of the timeline earlier. It is a safety net for dead air no frame was
  captured during — it discards no content, because there was none.
- **A wait on Claude Code's own UI must be a SINGLE token.** It styles every
  word as its own run, and the serialized snapshot carries SGR codes at each
  boundary, so `accept edits on` is stored as `accept`/`edits`/`on` and the
  literal never appears — `engineReady` waits on the bare word `edits`. Waits
  on Rove's UI or on shell output (`"groupId"`, the pinned prompt) are
  contiguous and may be phrases.
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

## Historical hero still

The old replay-derived hero used one frame with every stage temporarily
un-regioned. Do not use this flow for the current README image; capture it
through `bun run visual:serve` plus `visual:shot` as documented in
`docs/HARNESS.md`.

```bash
# stages[].region removed in a scratch copy, then (30fps × the capture second
# where the finished turn is on screen — scan frames.json for the milestone,
# every recapture moves it):
bun x remotion still src/index.ts quicklook-replay hero.png --frame=1630 --scale=2
```

The browser `/harness` path is the sole ground truth for UI screenshots and
acceptance. A richer fixture must still be driven through that path rather
than by publishing this direct-PTY replay.
