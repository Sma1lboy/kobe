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

## Behavioral self-test

`test/behavior/harness.ts` runs `dist/cli/index.js` in a disposable HOME and
XDG tree with PATH-first `kobe` and fake engine shims. Daemon and PTY Host paths
derive from that home, so setup and teardown cannot reach production state.

The suite currently pins:

- built CLI update behavior;
- PureTUI terminal title publication when native PTY support is available;
- headless `kobe api add --prompt` auto-starting `<taskId>::tab-1`;
- `send` reusing that exact hosted session;
- archive stopping the hosted session without deleting the Worktree.

Behavior tests run in CI and the release workflow. They require a build first:

```bash
cd packages/kobe
bun run build
bun run test:behavior
```

## OpenTUI visual ground truth

Agent visual iteration and UI acceptance have exactly one path:

```text
fixed 1280×800 Chromium → /harness → xterm.js → PTY sidecar
→ isolated dev:sandbox → real daemon/task/issue fixture → OpenTUI
```

```bash
bun run visual          # compare against the committed baseline
bun run visual:update   # intentionally accept a UI change (updates baseline)
```

Both commands rebuild a disposable fixture under `.scratch/opentui-visual-*`
(real git repo, real task, three issues via `kobe api`), drive the real TUI
through the harness (`c` → Kanban, `n` → New Story), take the single
`kanban-new-issue.png` screenshot, and tear everything down. Ports derive from
`KOBE_VISUAL_PORT_BASE` (default 5273); a busy port fails fast — never reuse a
stray server, and never point the fixture at a real HOME or the shared
`.dev-sandbox/home`. Local Terminal screenshots, native `kobe-web` pages such
as `/board`, render-test frames, and `dev:mock` cannot approve visual changes;
`test:e2e` (dev:mock) stays a PTY-transport smoke only. Failure artifacts land
in `packages/kobe-web/test-results/` (actual/diff/trace).

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
  backend;
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
