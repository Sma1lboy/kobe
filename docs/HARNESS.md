# Harness and verification contract

Tests prove behavior at the narrowest reliable boundary, then add black-box
coverage where packaging, process lifetime, terminal IO, or filesystem state
matters.

## Test tracks

- `bun run test:fast` — Vitest unit/integration tests outside daemon socket,
  render, and behavior directories.
- `bun run test:socket` — real Unix-socket daemon and PTY Host lifecycle tests.
- `bun run test:render` — opentui render tests.
- `bun run test:behavior` — built-CLI black-box tests.
- `bun run test` — the package's required fast + socket aggregate.

The render track is a required macOS CI/release gate. It uses Bun's native
OpenTUI renderer and carries the same 50% per-touched-file floor as Vitest for
`.tsx` components and React-owning hooks. The separate required visual gate
runs the committed browser journey on Linux, which compiles node-pty and can
create a real PTY in the hosted environment. The Ubuntu V8 coverage job remains
the fast/unit track; it does not pretend Node can execute OpenTUI components.

## Golden ground truth

Some behavior is a table, not a sentence. Where a surface has a state
VOCABULARY — a priority ladder, a glyph set, a layout that must hold across a
dozen combinations — the contract is a committed text file that the test
regenerates and compares byte for byte. The file is the specification: any
change to it lands as a reviewable diff instead of a silent behavior shift, and
a combination nobody thought to write a case for is still covered.

Goldens ride the existing tracks rather than adding one. `test/golden/` runs
under `test:fast`; `test/render/golden/` runs under `test:render`.
`test/golden/golden-file.ts` is the shared, framework-free plumbing both use.

| Golden | Track | Locks |
| --- | --- | --- |
| `test/golden/sidebar-row-state.golden.txt` | fast | `buildSidebarRowView` over its full input space — activity state × seen bit × worktree job × deletion phase × vendor × transcript, plus spinner frame sets, the `withSpinnerFrame` overlay contract, the turn-complete/transcript grace boundary, subagent marks, subtitle truncation, the PR chip, and `tabRowActivity`. |
| `test/render/golden/*.frame.txt` | render | Whole captured OpenTUI frames of the real `SidebarTree` — every state glyph, the per-level indent, the right-edge cluster, search pruning, view tabs, move mode, the recent-jump row, and the empty rail. |

Rules:

- **Regenerate deliberately, then read the diff.** `KOBE_UPDATE_GOLDEN=1 bun run
  test:fast` / `KOBE_UPDATE_GOLDEN=1 bun run test:render`. An unexplained line
  in that diff is the finding, not the noise.
- **A missing golden fails.** It is never auto-created on first run — a golden
  that writes itself would pass its own first CI run while asserting nothing.
- **Pin anything ambient the capture depends on.** The sidebar goldens pin the
  locale (subtitles come from `t()`) and every timestamp (the row view compares
  `at` against transcript mtime). A frame that animates masks exactly its
  animating cell and stays byte-exact everywhere else; a row whose label comes
  from real git HEAD is kept out of the frames and covered by the pure matrix.
- **A golden replaces the cases it subsumes.** Keeping a hand-written sample of
  a row the table already enumerates leaves two sources of truth that can
  disagree. What survives alongside a golden is what a table of outputs cannot
  state: a collapse across an axis (all six `TaskStatus` values must produce ONE
  runtime projection), agreement BETWEEN functions (`rowIsLoading` vs the view's
  own `loading`), and a keypress proving a CALLBACK fired — a binding that was
  never registered renders identically to one that works.

## Behavioral self-test

`test/behavior/harness.ts` runs the published `dist/cli/kobe.js` and
`dist/cli/rove.js` entries in a disposable HOME and XDG tree with PATH-first
CLI and fake engine shims. Daemon and PTY Host paths derive from that home, so
setup and teardown cannot reach production state.

The suite currently pins:

- built CLI update behavior;
- `rove` identity plus `ROVE_*` precedence through both public entry points;
- PureTUI terminal title publication when native PTY support is available;
- headless `rove api add --prompt` auto-starting `<taskId>::tab-1`;
- `send` reusing that exact hosted session;
- archive stopping the hosted session without deleting the Worktree.

Behavior tests run in CI and the release workflow. They require a build first:

```bash
cd packages/kobe
bun run build
bun run test:behavior
```

These drive a real PTY, a real daemon, and real child processes, so they are
timing-exposed in a way unit tests are not — the failure mode is a keypress
landing before the surface that handles it is live. Two rules keep that from
reaching the release pipeline:

- **Retry is configured** (`--retry=2` on `test:behavior`), for this suite
  only. A single red run of a process-driving test is not evidence.
- **Poll, never sleep-then-assert.** A fixed wait encodes one runner's speed.
  Re-assert the precondition inside the retry loop, not once before it: the
  open-worktree test pressed `ctrl+q` once, then retried only `o` for 15s, so
  a boot that placed focus a beat late spent every retry on the wrong pane
  (green on `ci.yml`, red on `release.yml`, same commit — v0.8.58).

## OpenTUI visual ground truth

Agent visual iteration and UI acceptance have exactly one path:

```text
fixed 1280×800 Chromium → /harness → xterm.js → PTY sidecar
→ isolated dev:sandbox → real daemon/task/issue fixture → OpenTUI
```

```bash
bun run visual          # hermetic journey: real OpenTUI drives, assertions read the buffer (~10-15s)

bun run visual:serve    # warm iteration servers + reusable fixture (keep running)
bun run visual:dev      # fast baseline check against visual:serve (~2s)
cd packages/kobe-web && bun run visual:shot -- ctrl+h c   # ad-hoc screenshot (~2s)
cd packages/kobe-web && bun run visual:shot -- --scale=2 --out=shot.png
```

Iterate with the warm loop (`visual:serve` once, then `visual:dev` /
`visual:shot` per change — `visual:shot` takes key tokens plus `text:…` and
`wait:<ms>`, and prints the PNG path); accept with hermetic `visual`, which
refuses to reuse a running server — stop `visual:serve` first.
`KOBE_VISUAL_FRESH=1` forces a fixture rebuild.

`--scale=N` sets the device pixel ratio while the viewport stays 1280×800, so
the TUI keeps its cell grid and only the raster gets denser — that is how a
`docs/assets` still gets captured at 2× without changing what the TUI lays
out. Ports come from `KOBE_VISUAL_PORT_BASE`, so pointing the shot at another
harness instance (a throwaway home with a richer fixture, say) is just an env
var — the ground-truth path is unchanged.

### README and docs assets

Marketing stills and the demo video ride that same `/harness` path, against a
RICHER throwaway home — the visual fixture is one empty task and photographs
as an empty product. `packages/kobe-web/e2e/hero-*.ts` owns it:

```bash
cd packages/kobe-web
bun e2e/hero-fixture.ts --fresh   # isolated home + a real repo with history
bun e2e/hero-seed.ts              # REAL Claude Code turns on two worktrees
bun e2e/hero-issues.ts            # the kanban board's stories (no quota)
bun e2e/hero-serve.ts             # warm capture stack on :5323 (keep running)

bun e2e/hero-shot.ts --scale=2 --out=../../docs/assets/workspace.png ctrl+a l
bun e2e/hero-record.ts            # demo.mp4 + demo.gif (4× cut)
bun e2e/hero-kanban.ts            # kanban.mp4 + kanban.gif (3× cut)
bun e2e/hero-routines.ts          # routines.mp4 + routines.gif (3× cut)
```

`hero-capture.ts` holds what the recorders share — the `/harness` browser PTY,
the typed-and-verified input helpers, and the encode — so a storyboard file is
only its beats. `--encode-only` re-encodes the take already on disk.

- **`HOME` stays the operator's**, alone among the isolation knobs: the engine
  under capture is the real `claude`, and a redirected home photographs a
  login screen. `ROVE_HOME_DIR` and the settings blob still land in
  `.scratch/hero/`, and every inherited daemon/task/`CLAUDE_CODE_*` marker is
  scrubbed — a capture run from inside a Rove task must never reach the
  operator's daemon, and an inherited child-session marker turns the engine's
  transcript off, which empties the pane the screenshot is of.
- **Turns are real, so the output is not reproducible** — expect the
  transcript, and so the framing, to differ every run. Seeding is idempotent:
  a re-shoot reuses the sessions it already paid quota for.
- **The kanban capture is the exception: no engine, fully deterministic.** A
  card reaches In progress by being LINKED to a task, so `hero-issues.ts`
  seeds the board off the fixture's idle tasks, and `hero-kanban.ts` fires a
  real `rove api issue-update --task` mid-take to move a card on camera. It
  files a story and creates a task, so it is NOT idempotent — re-shoot from
  `hero-fixture.ts --fresh && hero-issues.ts`. It also stops short of the
  drawer's Start: a story started into its own worktree boots the engine in a
  directory Claude Code has never seen, and the folder-trust prompt would be
  what got filmed.
- **The routines capture costs no quota either, and IS idempotent.** A routine
  is a daemon record and the fixture seeds three, so `hero-routines.ts` only
  needs the page; it composes one on camera and removes it through
  `rove api routine-delete` after the take, leaving the same three rows the
  stills were framed on. It stops short of `run now` for the same folder-trust
  reason the kanban take stops short of Start.
- **The fixture seeds the skill hint by VERSION.** `HOME` stays the operator's,
  so an already-installed skill that is merely behind this build takes the
  *stale* path, gated on `skillHintSeen:v<N>` — unseeded, the TUI opens on an
  interactive "update now? [y/n/d]" prompt, never renders, and every capture
  times out waiting for the sidebar. `hero-fixture.ts` reads the version off
  the BUILT skill, so `bun run build` in `packages/kobe` has to be current.
- **Video beats switch panes by CLICKING rows**, never by the `ctrl+a` prefix.
  The prefix is two strokes, and while an engine streams into the pane the
  second one gets starved — the storyboard then types its own navigation keys
  into a chat composer and films it.
- Encoding uses Remotion's bundled ffmpeg (`bun x remotion ffmpeg` from
  `packages/branding`); the repo has no system ffmpeg, and Playwright's build
  ships neither h264 nor the gif palette filters. That build is also
  `--disable-filters` with a small whitelist, so the speed-up is `-itsscale`
  and the gif frame rate is an output `-r` — `setpts` and `fps` do not exist.

Both commands rebuild a disposable fixture under `.scratch/opentui-visual-*`
(real git repo, real task, three issues via `rove api`). Each journey gets a
fresh `/harness` browser PTY and starts from the Workspace; the journeys are
independent, not one long stateful session. CI and release run this exact
command on Linux.

| Journey | Real OpenTUI route | Contract pinned |
| --- | --- | --- |
| Help and settings | Workspace → `F1` Help → close → Settings → close | Global modal and sidebar page transitions return to the live Workspace. |
| Worktree audit | Workspace sidebar → Worktrees → close | The daemon-backed Worktrees page loads from the real fixture and returns safely. |
| Story detail | Workspace sidebar → Kanban → select fixture card → detail drawer → close | Board selection reaches the persisted story detail without mutating it. |
| Story intake | Workspace sidebar → Kanban → New Story → title and description | The creation drawer accepts real terminal input and echoes it back. |

Ports derive from `KOBE_VISUAL_PORT_BASE` (default 5273); a busy port fails
fast — never reuse a stray server, and never point the fixture at a real HOME
or the shared `.dev-sandbox/home`. Local Terminal screenshots, native
`kobe-web` pages such as `/board`, render-test frames, and `dev:mock` cannot
approve visual changes; `test:e2e` (dev:mock) stays a PTY-transport smoke only.
Failure artifacts land in `packages/kobe-web/test-results/` (actual/diff/trace).

### Driving a live engine to observe STATE

The journey above proves what the TUI renders. A different class of bug —
"the badge never cleared after I answered" — needs a real vendor engine
running, answered by a real keypress, while the daemon's state is sampled
across the moment. The same harness carries it; the trap is that almost every
shortcut around it silently measures nothing.

What actually works:

- **Drive keys through the browser.** Chrome MCP over HTTP works even when a
  tool session has expired — `initialize`, keep the `mcp-session-id` header,
  then `tools/call`. Read the screen from `.xterm-rows`, and send keys by
  clicking `.xterm-screen` first, then targeting `.xterm-helper-textarea`.
  A page-level keypress does not reach the terminal.
- **Sample state from the daemon, not the screen.** `rove api inspect` reports
  both levels; a tab badge and its task rollup can disagree, and that
  disagreement is usually the bug.

What silently produces a false result:

- **`api read-output` for a vendor TUI.** Claude and Codex run on the alternate
  screen, so the text tail is escape-code noise (`">0q"`) no matter how healthy
  the session is. Absence of output is not absence of a dialog.
- **`api dispatch` as a stand-in for typing.** It publishes on
  `session.deliver`, which an attached client performs — with nobody attached
  the text goes nowhere and the call still answers `ok`. It also pastes text,
  which cannot select an option in a permission dialog. Check the reported
  `clients` count.
- **A non-TTY engine.** Claude exposes no AskUserQuestion tool unless stdin is
  a terminal; piped, it answers in prose and the dialog never exists.
- **Answering too fast.** The vendor notification that produces
  `permission_needed` fires only after ~6s of user idle
  (`DEFAULT_INTERACTION_THRESHOLD_MS`), so an instant reply reproduces a state
  the user never sees. Let the dialog sit.

Isolation for this mode is stricter than `KOBE_HOME_DIR` alone: the engine's
hook commands invoke whichever `kobe`/`rove` is on PATH, which resolves its own
socket, so a sandbox daemon never sees the events. Inline the socket path and
the source CLI into the hook command itself. A fresh HOME also needs
`hasCompletedOnboarding` seeded and its folder-trust gate answered, and
`KOBE_PTY_DEV_COMMAND` must be a script path — nested quotes are lost when the
dev server re-spawns the sidecar.

## Terminal endurance probe

`perf:golden` stays the fast release doctor. For multi-tab retention and
park/wake regressions, run the non-CI hosted-PTY soak on a development machine:

```bash
cd packages/kobe
bun run pty:soak -- --tabs=50 --cycles=5 --lines=1200
```

It creates a disposable `KOBE_HOME_DIR`, drives long output through real hosted
shells, parks every tab, lets them keep emitting while hidden, then proves each
wake sees its exact delta. It fails on lost markers or any full-replay fallback,
not timing. `--tabs` accepts up to 100; the printed temporary home is retained
for post-failure inspection and never points at production state.

## Regression policy

- A bug fix includes a test that fails for the reported defect and passes with
  the fix.
- Environment-shaped defects belong in `test/behavior/` when mocks would hide
  the real packaged path or process boundary.
- Protocol and lifecycle defects use real socket tests when practical.
- Pure state machines, parsers, launch builders, and key dispatch use fast
  deterministic tests.
- Performance gates assert operation counts, identity reuse, or bounded work;
  they do not assert wall-clock timing in CI.

## Architectural gates

- touched source files stay at or below roughly 500 lines;
- render paths do not run synchronous subprocesses outside the explicit
  whitelist;
- production code cannot import, spawn, or configure the retired session
  backend; the sole exception is `cli/legacy-tmux.ts`, which only diagnoses
  and removes pre-v0.8 leftovers for `doctor` / `reset`;
- published source changes include one patch changeset by default;
- daemon/orchestrator/engine edits are verified after replacing stale daemon
  processes in the chosen sandbox.

## Required pre-PR command

```bash
bun run lint && \
bun run typecheck && \
bun run test && \
(cd packages/kobe && bun run build && bun run test:behavior)
```

Inspect `git status`, `git diff`, touched-file sizes, and the changeset before
committing. Do not weaken a gate to make a change pass; move logic to the
correct boundary or add the missing test seam.
