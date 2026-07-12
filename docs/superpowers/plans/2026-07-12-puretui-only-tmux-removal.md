# PureTUI-only tmux Removal Implementation Plan

> **Execution contract:** Implement this plan inline with `superpowers:executing-plans`, one checked task at a time. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete tmux as a runtime and product surface, make the PTY Host the only session backend, and preserve unattended `send/add/fan-out` automation.

**Architecture:** First extract the generic shell/init launch builder from tmux and add one PTY Host session controller. Then route CLI and daemon session lifecycle through that controller. Once retained PureTUI code has no tmux imports, delete the tmux module graph, pane hosts, commands, configuration, tests, workflows, and active documentation.

**Tech Stack:** TypeScript 5.8, Bun 1.3, Vitest 2.1, React 19, OpenTUI 0.4, Changesets.

## Global Constraints

- Plain `kobe` has exactly one launch path: PureTUI.
- The standalone PTY Host is the only engine/shell session owner.
- `kobe api send`, prompted `add`, and `fan-out` auto-start `<taskId>::tab-1` when absent.
- Repository init scripts, one-time markers, model effort, engine protocols, and explicit first prompts survive the migration.
- No tmux compatibility adapter, runtime probe, process spawn, socket env, keybinding namespace, or disabled dead code remains.
- Historical CHANGELOG text may mention tmux; active instructions and production code may not depend on it.
- Every touched source file stays at or below 500 lines; no new dependencies.
- Use patch Changeset bump.
- Never stage or modify `.agents/skills/brand-studio` or the user's `.planning/` files.

---

### Task 1: Extract the neutral engine launch builder

**Files:**
- Create: `packages/kobe/src/engine/session-launch.ts`
- Create: `packages/kobe/test/engine/session-launch.test.ts`
- Modify: `packages/kobe/src/tui/workspace/terminal-tabs-core.ts`
- Modify: `packages/kobe/src/tui-react/workspace/TerminalTabs.tsx`
- Modify: `packages/kobe/src/tui-react/workspace/show-workspace.tsx`
- Later delete source: `packages/kobe/src/tmux/launch-line.ts`

**Interfaces:**
- Produces: `EngineSessionLaunch = { command: readonly string[]; key: string }`.
- Produces: `engineSessionKey(taskId: string): string` returning `${taskId}::tab-1`.
- Produces: `buildEngineSessionLaunch(input): EngineSessionLaunch` where input contains task identity/kind/vendor/repo, worktree, shell, an already resolved per-tab engine argv, prompt intent, and optional init timeout.
- Retains: `resolveRepoInitTimeoutSeconds`, `REPO_INIT_TIMEOUT_SECONDS`, and the bounded init/marker behavior currently in `tmux/launch-line.ts`.

- [ ] **Step 1: Write failing launch-builder tests**

Cover these independent behaviors:

```ts
expect(engineSessionKey("task-1")).toBe("task-1::tab-1")

const launch = buildEngineSessionLaunch({
  task: { id: "task-1", kind: "task", vendor: "claude", repo: "/repo" },
  worktreePath: "/repo/.worktrees/task-1",
  shell: "/bin/zsh",
  explicitPrompt: "fix it",
})
expect(launch.command.slice(0, 2)).toEqual(["/bin/zsh", "-ilc"])
expect(launch.command[2]).toContain("claude")
expect(launch.command[2]).toContain("'fix it'")
expect(launch.command[2]).toContain('exec "${SHELL:-/bin/sh}"')
```

Add fixtures proving `.kobe/init.sh` precedes the engine, successful init touches `worktreeInitMarkerPath`, timeout remains bounded, a main task receives dispatcher protocol, and a regular task receives worktree protocol.

- [ ] **Step 2: Run RED**

Run: `cd packages/kobe && bun run test:fast test/engine/session-launch.test.ts`

Expected: FAIL because `engine/session-launch.ts` does not exist.

- [ ] **Step 3: Implement the neutral builder**

Move the generic constants and functions `keepAlive`, `EngineInitLaunch`, `resolveRepoInitTimeoutSeconds`, `boundedInitGroup`, and `engineLaunchLine` out of `tmux/launch-line.ts`. Keep tmux-only `historyPaneKeepAlive` and `engineTabExitCleanup` behind until the tmux deletion task.

Compose the launch as:

```ts
export function engineSessionKey(taskId: string): string {
  return `${taskId}::tab-1`
}

export function buildEngineSessionLaunch(input: EngineSessionLaunchInput): EngineSessionLaunch {
  const protocolTaskId = input.task.kind === "main" ? undefined : input.task.id
  const dispatcherTaskId = input.task.kind === "main" ? input.task.id : undefined
  const launchInit = resolveEngineLaunchInit(input.task.repo ?? "", input.worktreePath, input.promptIntent)
  let argv: readonly string[] = withDispatcherProtocol(
    withWorktreeProtocol(
      input.argv,
      input.task.vendor,
      protocolTaskId,
    ),
    input.task.vendor,
    dispatcherTaskId,
  )
  if (launchInit.firstMessage) argv = [...argv, launchInit.firstMessage.text]
  const script = engineLaunchLine(quoteShellArgv(argv, { bareSafe: true }), {
    initScript: launchInit.initScript,
    markerPath: launchInit.initScript ? worktreeInitMarkerPath(input.worktreePath) : undefined,
    timeoutSeconds: input.initTimeoutSeconds,
  })
  return { key: engineSessionKey(input.task.id), command: [input.shell, "-ilc", script] }
}
```

The caller owns per-tab session semantics before invoking the builder: the UI uses `engineTabArgv` for pin/resume and API cold-start uses `withClaudeSessionId` once. The builder owns protocol composition, repo init, and exactly one first-message source. With `{ kind: "explicit", prompt }`, the explicit prompt wins; with `{ kind: "repo-init" }`, the repo init prompt is appended when present; with `{ kind: "none" }`, no prompt is appended.

- [ ] **Step 4: Make PureTUI use the builder**

Replace `engineTabSpawnFor`'s local shell wrapping with the neutral builder. Keep per-tab resume/session-id policy in `terminal-tabs-core.ts`; pass its resolved argv into the builder. The first engine tab uses the caller-supplied explicit quick-fork prompt when present, otherwise `repo-init`; later tabs use `none` so a repo init prompt is not replayed. Repo init script execution remains marker-gated for every launch.

- [ ] **Step 5: Run GREEN and adjacent terminal tests**

Run:

```bash
cd packages/kobe
bun run test:fast test/engine/session-launch.test.ts test/tui/terminal-tabs-core.test.ts test/tui/terminal-registry.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/kobe/src/engine/session-launch.ts packages/kobe/test/engine/session-launch.test.ts packages/kobe/src/tui/workspace/terminal-tabs-core.ts packages/kobe/src/tui-react/workspace/TerminalTabs.tsx packages/kobe/src/tui-react/workspace/show-workspace.tsx
git commit -m "refactor: centralize hosted engine launch" -m "Move shell, repo-init, protocol, and prompt composition into a neutral engine-session builder. Use the same launch contract for PureTUI tabs and future headless PTY automation."
```

### Task 2: Replace API tmux fallback with PTY auto-start

**Files:**
- Modify: `packages/kobe/src/cli/api/pty-delivery.ts`
- Modify: `packages/kobe/src/cli/api/runtime.ts`
- Modify: `packages/kobe/src/cli/api/types.ts`
- Modify: `packages/kobe/test/cli/api-cmd-runtime.test.ts`
- Modify: `packages/kobe/test/cli/pty-delivery.test.ts`
- Create: `packages/kobe/test/behavior/pty-api-autostart.test.ts`

**Interfaces:**
- Produces: `ensurePtyHost(): Promise<{ rpc: PtyHostRpc; close(): void }>` which calls `ensurePtyHostReachable()` before connecting.
- Produces: `openEngineSession(rpc, launch): Promise<PtyOpenResult>`.
- `PromptDeliveryOps` becomes PTY-only: ensure host, list, open, write, kill, build launch.

- [ ] **Step 1: Write RED tests for fresh auto-start**

Pin the exact request order for a missing session:

```ts
expect(requests.map((r) => r.name)).toEqual([
  "pty.list",
  "pty.open",
  "pty.write",
  "pty.detach",
])
expect(requests.find((r) => r.name === "pty.open")?.payload).toMatchObject({
  key: "task-1::tab-1",
  cwd: "/worktrees/task-1",
})
expect(result).toMatchObject({
  session: "task-1::tab-1",
  pane: "task-1::tab-1",
  started: true,
  delivered: true,
})
```

Add cases for existing alive session (bracketed paste + CR, `started:false`), `created:false` race (do not type launch input twice), host startup failure (`SESSION_FAILED`), dead engine key, running detection, and idempotent teardown.

- [ ] **Step 2: Run RED**

Run: `cd packages/kobe && bun run test:fast test/cli/pty-delivery.test.ts test/cli/api-cmd-runtime.test.ts`

Expected: fresh delivery still invokes tmux seams or cannot auto-start PTY.

- [ ] **Step 3: Implement PTY-only delivery**

Delete `sessionExists`, `ensureSession`, `waitForEnginePane`, `pasteAndSubmit`, tmux session naming, and tmux budgets from `PromptDeliveryOps` and `runtime.ts`.

For a fresh key:

```ts
const launch = ops.buildEngineLaunch(target, worktree, prompt)
const open = await host.rpc.request<PtyOpenResult>("pty.open", {
  key: launch.key,
  cwd: worktree,
  command: launch.command,
  cols: 80,
  rows: 24,
})
if (!open.alive) throw new ApiError(`failed to start hosted session for ${target.id}`, "SESSION_FAILED")
if (open.created) {
  // command already contains the explicit prompt; no composer paste
  await host.rpc.request("pty.detach", { key: launch.key })
  return { session: launch.key, pane: launch.key, started: true, engineReady: true, delivered: true }
}
return deliverExisting(host.rpc, launch.key, worktree, prompt)
```

Use `ensurePtyHostReachable()` for missing host rather than returning `null`.
`defaultApiRuntime.isTaskRunning` checks PTY inventory only; teardown kills all task keys only.

- [ ] **Step 4: Run GREEN**

Run: `cd packages/kobe && bun run test:fast test/cli/pty-delivery.test.ts test/cli/api-cmd-runtime.test.ts test/cli/api-handlers.test.ts`

Expected: all pass with no tmux mocks in API tests.

- [ ] **Step 5: Add and run black-box automation coverage**

Build the CLI, create a scratch task in a disposable behavior home, invoke prompted `kobe api add` without an open TUI, and assert `kobe api pty-list` reports an alive `<taskId>::tab-1` session whose command is the fake engine shell.

Run: `cd packages/kobe && bun run build && KOBE_INCLUDE_BEHAVIOR=1 bunx vitest run test/behavior/pty-api-autostart.test.ts --pool forks --minWorkers=1 --maxWorkers=1`

- [ ] **Step 6: Commit**

```bash
git add packages/kobe/src/cli/api/pty-delivery.ts packages/kobe/src/cli/api/runtime.ts packages/kobe/src/cli/api/types.ts packages/kobe/test/cli/api-cmd-runtime.test.ts packages/kobe/test/cli/pty-delivery.test.ts packages/kobe/test/behavior/pty-api-autostart.test.ts
git commit -m "feat: auto-start API sessions in PTY host" -m "Make hosted PTYs the only prompt-delivery backend and preserve unattended send/add/fan-out startup. Remove the tmux fallback, duplicate-engine risk, and tmux liveness seams."
```

### Task 3: Move daemon and task lifecycle to PTY teardown

**Files:**
- Modify: `packages/kobe/src/core/daemon-session-adapter.ts`
- Modify: `packages/kobe/src/core/daemon-runtime.ts`
- Modify: `packages/kobe-daemon/src/daemon/runtime.ts`
- Modify: `packages/kobe-daemon/src/daemon/auto-title-poller.ts`
- Modify: `packages/kobe/src/tui/lib/task-actions.ts`
- Modify: `packages/kobe/src/tui-react/workspace/host-task-actions.ts`
- Modify: `packages/kobe/test/core/daemon-session-adapter.test.ts`
- Modify: `packages/kobe/test/tui/task-actions.test.ts`
- Delete later: `packages/kobe/src/tmux/chat-tab-naming.ts`
- Delete later: `packages/kobe/test/tmux/chat-tab-naming.test.ts`

**Interfaces:**
- `ensureTaskSessionAdapter` opens/detaches the deterministic PTY key and returns `{ session: key, worktreePath }`.
- `tearDownTaskSessionAdapter` kills every PTY key for the task.
- `TaskActionContext` receives a backend-neutral `tearDownTaskSessions(taskId)` dependency; no switch-client option.

- [ ] **Step 1: Rewrite daemon-session tests to RED**

Expect `pty.open`/`pty.detach` rather than `tmux new-session`, and expect teardown to issue `pty.list` then `pty.kill` for all matching keys. Add an absent-host idempotence case.

- [ ] **Step 2: Run RED**

Run: `cd packages/kobe && bun run test:fast test/core/daemon-session-adapter.test.ts test/tui/task-actions.test.ts`

- [ ] **Step 3: Implement hosted lifecycle adapters**

Reuse Task 2's PTY controller. Remove `runChatTabNamingPass` from `DaemonRuntimeAdapter`, `daemonRuntime`, and `auto-title-poller`; keep transcript-derived task title polling.

In task actions, replace `tmuxSessionName/switchClientBeforeKill/killSession` with injected hosted teardown after archive/delete. Preserve active-task selection and confirmation behavior.

- [ ] **Step 4: Run GREEN**

Run: `cd packages/kobe && bun run test:fast test/core/daemon-session-adapter.test.ts test/tui/task-actions.test.ts test/tui/task-actions-rename.test.ts test/daemon/auto-title-poller.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/kobe/src/core/daemon-session-adapter.ts packages/kobe/src/core/daemon-runtime.ts packages/kobe-daemon/src/daemon/runtime.ts packages/kobe-daemon/src/daemon/auto-title-poller.ts packages/kobe/src/tui/lib/task-actions.ts packages/kobe/src/tui-react/workspace/host-task-actions.ts packages/kobe/test/core/daemon-session-adapter.test.ts packages/kobe/test/tui/task-actions.test.ts
git commit -m "refactor: make task lifecycle PTY-only" -m "Route daemon session creation and archive/delete teardown through hosted PTYs. Remove tmux client switching and the obsolete chat-tab naming runtime contract."
```

### Task 4: Make CLI, maintenance, settings, and help PureTUI-only

**Files:**
- Modify: `packages/kobe/src/cli/index.ts`
- Modify: `packages/kobe/src/cli/usage.ts`
- Modify: `packages/kobe/src/cli/subcommands.ts`
- Modify: `packages/kobe/src/cli/maintenance.ts`
- Modify: `packages/kobe/src/cli/doctor-resources.ts`
- Modify: `packages/kobe/scripts/dev-sandbox.ts`
- Delete: `packages/kobe/src/launch-mode.ts`
- Delete: `packages/kobe/scripts/dev-sandbox-args.ts`
- Delete: `packages/kobe/src/cli/commands-tui.ts`
- Delete: `packages/kobe/src/tui/direct.ts`
- Modify: `packages/kobe/src/tui/index.tsx`
- Modify: `packages/kobe/src/tui/context/keybindings-user.ts`
- Modify: `packages/kobe/src/state/keybindings-file.ts`
- Modify: `packages/kobe/src/tui-react/component/help-dialog.tsx`
- Modify: `packages/kobe/src/tui-react/component/settings-dialog/sections-misc.tsx`
- Modify matching CLI/settings/help tests.

**Interfaces:**
- Bare launch calls `startTui()` with no mode argument.
- `kobe reset` stops daemon and PTY Host; `doctor` reports PTY Host resources.
- `reload`, `kill-sessions`, `--tmux`, and `--puretui` are unknown commands/flags.

- [ ] **Step 1: Write RED CLI tests**

Assert bare `kobe` calls `startTui()`; both mode flags and removed subcommands exit 2; help contains neither tmux nor mode flags; reset calls no tmux seam; doctor output contains `pty host` and no tmux requirement.

- [ ] **Step 2: Run RED**

Run: `cd packages/kobe && bun run test:fast test/cli/index-dispatch.test.ts test/cli/usage.test.ts test/cli/maintenance-doctor.test.ts test/cli/maintenance-reset.test.ts`

- [ ] **Step 3: Simplify production CLI and sandbox**

Remove launch parsing and dynamic tmux dispatch. `startTui()` always imports `startWorkspaceHost`. Remove pane-host routes, `reload`, and `kill-sessions`; retain internal `pty-host`. Simplify `dev-sandbox.ts` to `run/reset/home` and make reset invoke `kobe reset --yes` against isolated state.

- [ ] **Step 4: Remove tmux settings/help namespace**

Delete `tmux.*` binding defaults and extraction branches, tmux prefix probing, tmux hint rows, and Settings copy. Keep PureTUI prefix/direct aliases.

- [ ] **Step 5: Run GREEN**

Run: `cd packages/kobe && bun run test:fast test/cli/index-dispatch.test.ts test/cli/usage.test.ts test/cli/maintenance-doctor.test.ts test/cli/maintenance-reset.test.ts test/tui/keybindings-user.test.ts test/tui-react/help-groups.test.ts`

- [ ] **Step 6: Commit**

Stage only the listed CLI/settings/help files and deletions, then commit:

```bash
git commit -m "refactor: make the CLI PureTUI-only" -m "Remove UI mode selection, tmux pane commands, tmux maintenance verbs, and tmux keybinding surfaces. Keep reset and doctor focused on the daemon and standalone PTY host."
```

### Task 5: Move generic helpers and delete the tmux module graph

**Files:**
- Move: `packages/kobe/src/tmux/editor-launch.ts` → `packages/kobe/src/tui/lib/editor-launch.ts`
- Move matching tests to `packages/kobe/test/tui/editor-launch*.test.ts`
- Delete: all remaining files under `packages/kobe/src/tmux/`
- Delete: tmux session/layout/chattab/heal files under `packages/kobe/src/tui/panes/terminal/`
- Delete: tmux-only pane host files under `packages/kobe/src/tui-react/{tasks-pane,quick-task,ops,settings,new-task,help,update,worktrees,history}/` while preserving components/cores imported by Workspace Host.
- Delete: `packages/kobe/src/tui/lib/task-enter.ts`, `attach-gate.ts`, `tmux-border-theme.ts`, and other now-unreferenced tmux-only helpers.
- Delete: tmux-only tests under `packages/kobe/test/tmux/`, `test/tui/`, and `test/behavior/`.
- Create: `packages/kobe/test/architecture/no-tmux-runtime.test.ts`.

**Interfaces:**
- Retained editor helper exports remain `resolveEditorLaunch`, `openInEditor`, and command-resolution types from the neutral path.
- Static guard owns the final “no runtime tmux” invariant.

- [ ] **Step 1: Move editor tests and watch RED**

Change imports to `src/tui/lib/editor-launch.ts` before moving the source.

Run: `cd packages/kobe && bun run test:fast test/tui/editor-launch-resolve.test.ts test/tui/editor-launch.test.ts`

Expected: FAIL until the helper is moved and importers updated.

- [ ] **Step 2: Move the generic editor helper and run GREEN**

Update `workspace/host.tsx` and every retained importer. Run the two editor tests.

- [ ] **Step 3: Add a static RED guard**

The guard scans production source and fails on:

```ts
expect(runtimePaths).not.toContain("/src/tmux/")
expect(sourceText).not.toMatch(/from ["'][^"']*(?:\/tmux|tmux\/)/)
expect(sourceText).not.toMatch(/Bun\.spawn\([^\n]*["']tmux["']/)
expect(sourceText).not.toContain("KOBE_TMUX_SOCKET")
```

Exclude historical CHANGELOG/spec/plan text and test fixture strings.

- [ ] **Step 4: Delete tmux-only files and repair imports**

Use `rg` after each deletion batch. Do not delete generic PTY, terminal render,
split-core, sidebar, dialog, FileTree, or engine history code merely because a
comment says “tmux-style”; remove or rewrite stale comments separately.

- [ ] **Step 5: Run architecture guard, typecheck, and fast tests**

Run:

```bash
cd packages/kobe
bun run test:fast test/architecture/no-tmux-runtime.test.ts
bun run typecheck
bun run test:fast
```

Expected: no deleted imports and all retained fast tests pass.

- [ ] **Step 6: Commit**

```bash
git status --short
git add <the explicitly reviewed tmux-removal source and test paths>
git commit -m "refactor: remove tmux runtime" -m "Delete the tmux backend, layout stack, pane hosts, helpers, and regression suites after moving retained editor behavior to a neutral owner. Add an architecture guard preventing tmux runtime dependencies from returning."
```

Before staging, inspect `git status` and explicitly name only paths belonging to this task. Never stage `.agents/skills/brand-studio` or `.planning/`.

### Task 6: Clean workflows, docs, skill, and release metadata

**Files:**
- Modify: `AGENTS.md`, `CONTEXT.md`, `README.md`, `docs/DESIGN.md`, `docs/ARCHITECTURE.md`, `docs/HARNESS.md`, `docs/KEYBINDINGS.md`, `docs/PLAN.md`, relevant active `docs/design/*.md`.
- Modify: `.agents/skills/kobe/SKILL.md` only if it is a normal tracked file and not the user's unrelated `brand-studio` change.
- Modify: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/workflows/claude-code-review.yml`.
- Modify: root/package scripts and behavior harness.
- Replace: `.changeset/puretui-default-launch.md` with `.changeset/puretui-only.md`.
- Delete: obsolete branch-only dual-mode spec/plan files.

**Interfaces:**
- Canonical product unit: `Task = git worktree + hosted engine sessions + branch`.
- CI behavior job no longer installs tmux.
- Release note includes one-time legacy cleanup command but no runtime promise.

- [ ] **Step 1: Update active documentation and skill**

Remove installation, lifecycle, keybinding, pane, and architecture guidance that treats tmux as live. Preserve explicitly historical CHANGELOG/decision records.

- [ ] **Step 2: Update CI and behavior harness**

Remove apt tmux installation and scratch tmux sockets. Rewrite behavior fixtures around disposable HOME, daemon, PTY Host, fake engine, and direct PureTUI/API driving.

- [ ] **Step 3: Write the patch changeset**

```md
---
"@sma1lboy/kobe": patch
---

Make PureTUI and its standalone PTY Host the only kobe runtime, preserve unattended API session startup through hosted PTYs, and remove the tmux backend, commands, keybindings, tests, and installation requirement. Existing users can stop sessions left by older releases once with `tmux -L kobe kill-server`.
```

- [ ] **Step 4: Run active-surface searches**

Run targeted `rg` searches proving no active doc, skill, workflow, script, or package metadata instructs users to install or run tmux. Historical files must be explicitly excluded, not silently counted as runtime violations.

- [ ] **Step 5: Commit**

Stage only docs/workflows/skill/changeset paths and commit:

```bash
git commit -m "docs: document the PureTUI-only runtime" -m "Update product vocabulary, help, development workflows, CI, and release metadata after removing tmux. Document hosted PTY automation and the one-time cleanup command for sessions left by older releases."
```

### Task 7: Full verification and PR delivery

**Files:**
- Verify only; fix regressions through new RED/GREEN cycles.

- [ ] **Step 1: Run static completion audit**

Prove:

- no production `src/tmux` directory;
- no `KOBE_TMUX_SOCKET` or tmux executable spawn;
- no public tmux CLI flag/subcommand;
- no tmux keybinding ids;
- PTY auto-start behavior test exists;
- all touched source files are at or below 500 lines;
- exactly one patch changeset describes PureTUI-only behavior.

- [ ] **Step 2: Run full local gates from a fresh command**

```bash
bun run lint && bun run typecheck && bun run test && (cd packages/kobe && bun run build && bun run test:behavior)
```

Expected: every command exits 0.

- [ ] **Step 3: Inspect scope**

```bash
git status --short --branch
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git log --oneline --decorate origin/main..HEAD
```

Confirm `.agents/skills/brand-studio` and `.planning/` remain unstaged and absent from every commit.

- [ ] **Step 4: Use the finishing-development-branch workflow**

Push `feat/puretui-only`, create a PR with `gh pr create`, inspect CI with `gh pr checks`, fix failures without bypassing hooks, and merge only after the user chooses the integration option required by the finishing skill.
