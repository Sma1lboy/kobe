# quicklook replay

The `quicklook-replay` Remotion composition renders the checked-in terminal
capture at `src/quicklook/frames.json` — the README demo video. It replays
the storyboard in `src/quicklook/quicklook.replay.json` through the real
PureTUI Workspace Host and Hosted PTY runtime: create a task and prompt it,
start a SECOND task while the first agent is still mid-turn, let both work,
then visit each one's own branch and diff.

That is the pitch — one TUI holding many engine sessions, each isolated on its
own worktree and branch. It is deliberately NOT `fan-out` (many attempts at a
single prompt): that mode multiplies token spend for one deliverable, and it
is not what the demo should be selling. The two prompts touch DISJOINT files
so "agents never trample each other" is visible on screen rather than claimed.

Ship the `quicklook-replay-4x` cut: a real turn takes tens of seconds, so the
1x capture runs minutes.

## Regenerate

```bash
bun --filter @sma1lboy/kobe build          # the capture drives the BUILT cli
cd packages/branding
KOBE_REPLAY_CLAUDE_COMMAND='claude --permission-mode acceptEdits --allowedTools "Bash(git *)"' \
bun run capture:puretui --keep-demo-root
bun x remotion render src/index.ts quicklook-replay-4x out/demo.mp4
cp out/demo.mp4 ../../docs/assets/demo.mp4
# the inline README GIF, at the same 960×540 / 10fps as the checked-in asset
bun x remotion render src/index.ts quicklook-replay-4x out/demo.gif \
  --codec=gif --scale=0.75 --every-nth-frame=3
cp out/demo.gif ../../docs/assets/demo.gif
```

- **The replay drives the REAL Claude Code**, not a stub: the demo has to show
  the product people actually install, down to its welcome box, tool calls and
  turn summaries. `scripts/fixtures/claude-demo` still exists for offline work
  on the pipeline itself, but a stub recording is not shippable — it renders a
  one-line fake banner, and kobe's live `ps`-walk labels its tab `shell`
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
- **A wait on Claude Code's own UI must be a SINGLE token.** It styles every
  word as its own run, and the serialized snapshot carries SGR codes at each
  boundary, so `accept edits on` is stored as `accept`/`edits`/`on` and the
  literal never appears — `engineReady` waits on the bare word `edits`. Waits
  on kobe's UI or on shell output (`"groupId"`, the pinned prompt) are
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

## The README hero still

`docs/assets/workspace.png` comes from this same capture, not a separate
session: render one frame with every stage temporarily un-regioned (the camera
is zoomed in at every rich moment, and a hero needs the whole workspace), then
restore the spec.

```bash
# stages[].region removed in a scratch copy, then:
bun x remotion still src/index.ts quicklook-replay hero.png --frame=3570 --scale=2
```

The browser `/harness` path is the ground truth for UI acceptance, but it is
the wrong tool here: it starts a FRESH engine session, so the shot shows a
welcome box instead of a finished turn, and the harness home has no engine
credentials of its own.
