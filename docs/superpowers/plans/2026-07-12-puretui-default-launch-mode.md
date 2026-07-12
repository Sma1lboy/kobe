# PureTUI Default Launch Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PureTUI the default `kobe` interface, expose explicit `--puretui` and `--tmux` launch flags, remove the `KOBE_TUI` runtime switch, and keep development launchers and help synchronized.

**Architecture:** A framework-free launch parser classifies argv as a UI launch, normal subcommand, or usage error. The CLI passes an explicit `LaunchMode` into the TUI bootstrap; neither the TUI nor environment layer reads argv or `KOBE_TUI`. The sandbox launcher validates its own `run/reset/home` mode and forwards only the two production launch flags.

**Tech Stack:** TypeScript 5.8, Bun 1.3, Vitest 2.1, React 19, Changesets.

## Global Constraints

- Bare `kobe` launches PureTUI; tmux remains available through `kobe --tmux`.
- `KOBE_TUI` is removed as a runtime control with no environment fallback.
- `--puretui` and `--tmux` are launch-only flags; conflicting flags exit 2 and launch nothing.
- Top-level help must state the PureTUI default and document both flags.
- `dev:sandbox:reset` and sandbox `home` behavior remain unchanged.
- No new dependencies; keep every touched source file at or below 500 lines.
- Add a patch changeset; do not edit generated release history in `packages/kobe/CHANGELOG.md`.
- Do not stage or modify the user's `.agents/skills/brand-studio` or existing `.planning/` files.

---

### Task 1: Parse the production launch contract at the CLI boundary

**Files:**
- Create: `packages/kobe/src/launch-mode.ts`
- Create: `packages/kobe/test/cli/launch-mode.test.ts`
- Modify: `packages/kobe/src/cli/index.ts:361-490`
- Modify: `packages/kobe/test/cli/index-dispatch.test.ts:151-180`

**Interfaces:**
- Produces: `LaunchMode = "puretui" | "tmux"`.
- Produces: `parseLaunchRequest(args: readonly string[]): LaunchRequest` where `LaunchRequest` is `{ kind: "launch"; mode: LaunchMode } | { kind: "command"; args: readonly string[] } | { kind: "error"; message: string }`.
- Consumes: `startTui(mode: LaunchMode)` implemented in Task 2.

- [ ] **Step 1: Write the failing parser tests**

```ts
import { describe, expect, it } from "vitest"
import { parseLaunchRequest } from "../../src/launch-mode"

describe("parseLaunchRequest", () => {
  it("defaults a bare invocation to PureTUI", () => {
    expect(parseLaunchRequest([])).toEqual({ kind: "launch", mode: "puretui" })
  })

  it.each([
    ["--puretui", "puretui"],
    ["--tmux", "tmux"],
  ] as const)("maps %s to %s", (flag, mode) => {
    expect(parseLaunchRequest([flag])).toEqual({ kind: "launch", mode })
  })

  it("keeps ordinary subcommands untouched", () => {
    expect(parseLaunchRequest(["doctor", "--bogus"])).toEqual({
      kind: "command",
      args: ["doctor", "--bogus"],
    })
  })

  it("rejects conflicting launch flags", () => {
    expect(parseLaunchRequest(["--tmux", "--puretui"])).toEqual({
      kind: "error",
      message: "kobe: --tmux and --puretui cannot be used together",
    })
  })

  it("rejects arguments after a launch flag", () => {
    expect(parseLaunchRequest(["--tmux", "doctor"])).toEqual({
      kind: "error",
      message: 'kobe: launch flag "--tmux" does not accept argument "doctor"',
    })
  })
})
```

- [ ] **Step 2: Run the parser test and verify RED**

Run: `cd packages/kobe && bun run test:fast test/cli/launch-mode.test.ts`

Expected: FAIL because `../../src/launch-mode` does not exist.

- [ ] **Step 3: Implement the minimal launch parser**

```ts
export type LaunchMode = "puretui" | "tmux"

export type LaunchRequest =
  | { kind: "launch"; mode: LaunchMode }
  | { kind: "command"; args: readonly string[] }
  | { kind: "error"; message: string }

const LAUNCH_FLAGS = ["--puretui", "--tmux"] as const
type LaunchFlag = (typeof LAUNCH_FLAGS)[number]

function isLaunchFlag(value: string | undefined): value is LaunchFlag {
  return value === "--puretui" || value === "--tmux"
}

export function parseLaunchRequest(args: readonly string[]): LaunchRequest {
  if (args.length === 0) return { kind: "launch", mode: "puretui" }
  const first = args[0]
  if (!isLaunchFlag(first)) return { kind: "command", args }
  const other: LaunchFlag = first === "--tmux" ? "--puretui" : "--tmux"
  if (args.includes(other)) {
    return { kind: "error", message: "kobe: --tmux and --puretui cannot be used together" }
  }
  if (args.length > 1) {
    return { kind: "error", message: `kobe: launch flag "${first}" does not accept argument "${args[1]}"` }
  }
  return { kind: "launch", mode: first === "--tmux" ? "tmux" : "puretui" }
}
```

- [ ] **Step 4: Run the parser test and verify GREEN**

Run: `cd packages/kobe && bun run test:fast test/cli/launch-mode.test.ts`

Expected: 5 tests pass.

- [ ] **Step 5: Add failing CLI dispatch assertions**

Update `packages/kobe/test/cli/index-dispatch.test.ts` so the existing bare-launch assertion expects `startTui("puretui")`, add an explicit `--tmux` assertion expecting `startTui("tmux")`, add an explicit `--puretui` assertion, and add a conflict assertion that expects stderr to contain `cannot be used together`, `process.exit(2)`, and no `startTui` call.

```ts
test("a bare `kobe` launches PureTUI", async () => {
  await runCli()
  expect(spies.startTui).toHaveBeenCalledWith("puretui")
})

test.each([
  ["--puretui", "puretui"],
  ["--tmux", "tmux"],
] as const)("kobe %s launches %s", async (flag, mode) => {
  await runCli(flag)
  expect(spies.startTui).toHaveBeenCalledWith(mode)
})

test("conflicting launch flags print usage and launch nothing", async () => {
  await runCli("--tmux", "--puretui")
  expect(stderrText()).toContain("cannot be used together")
  expect(stderrText()).toContain("Usage: kobe")
  expect(exitSpy).toHaveBeenCalledWith(2)
  expect(spies.startTui).not.toHaveBeenCalled()
})
```

- [ ] **Step 6: Run the dispatch test and verify RED**

Run: `cd packages/kobe && bun run test:fast test/cli/index-dispatch.test.ts`

Expected: FAIL because bare `kobe` passes no mode and launch flags are treated as unknown commands.

- [ ] **Step 7: Route launch requests before subcommand dispatch**

In `packages/kobe/src/cli/index.ts`, call `parseLaunchRequest(rawArgs)` before destructuring the subcommand. On `error`, write the message plus `topLevelUsage()` to stderr and exit 2. On `launch`, dynamically import `startTui`, call `startTui(request.mode)`, and return. On `command`, preserve the current dispatch path. Replace the old bare-`kobe` launch block rather than duplicating it so the file stays at or below 500 lines.

```ts
const request = parseLaunchRequest(rawArgs)
if (request.kind === "error") {
  process.stderr.write(`${request.message}\n\n${topLevelUsage()}\n`)
  process.exit(2)
}
if (request.kind === "launch") {
  const { startTui } = await import("../tui/index.tsx")
  await startTui(request.mode)
  return
}
const [subcommand, ...rest] = request.args
```

- [ ] **Step 8: Run focused CLI tests and verify GREEN**

Run: `cd packages/kobe && bun run test:fast test/cli/launch-mode.test.ts test/cli/index-dispatch.test.ts`

Expected: both files pass; `wc -l packages/kobe/src/cli/index.ts` reports 500 or fewer lines.

- [ ] **Step 9: Commit the production CLI slice**

```bash
git add packages/kobe/src/launch-mode.ts packages/kobe/src/cli/index.ts packages/kobe/test/cli/launch-mode.test.ts packages/kobe/test/cli/index-dispatch.test.ts
git commit -m "feat: add explicit TUI launch modes" -m "Make bare kobe resolve to PureTUI and add launch-only --puretui and --tmux flags. Reject conflicting launch flags before any UI starts while preserving normal subcommand routing."
```

### Task 2: Select the host explicitly and remove the environment switch

**Files:**
- Modify: `packages/kobe/src/tui/index.tsx:1-35`
- Modify: `packages/kobe/src/env.ts:42-51`
- Create: `packages/kobe/test/tui/start-tui.test.ts`

**Interfaces:**
- Consumes: `LaunchMode` from `packages/kobe/src/launch-mode.ts`.
- Produces: `startTui(mode: LaunchMode): Promise<void>`.

- [ ] **Step 1: Write a failing host-selection test**

Mock `publishKobeTerminalTitle`, `maybeHintSkillInstall`, `startWorkspaceHost`, and `startDirectTmux`, then import `startTui` fresh for each case.

```ts
it("starts the Workspace Host for puretui", async () => {
  await startTui("puretui")
  expect(startWorkspaceHost).toHaveBeenCalledOnce()
  expect(startDirectTmux).not.toHaveBeenCalled()
})

it("starts tmux Handover for tmux", async () => {
  await startTui("tmux")
  expect(startDirectTmux).toHaveBeenCalledOnce()
  expect(startWorkspaceHost).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the host-selection test and verify RED**

Run: `cd packages/kobe && bun run test:fast test/tui/start-tui.test.ts`

Expected: FAIL because `startTui` accepts no mode and still reads `KOBE_TUI` through `nativeChatEnabled()`.

- [ ] **Step 3: Pass the explicit mode through the bootstrap**

Change `startTui` to accept `mode: LaunchMode`, select the Workspace Host when `mode === "puretui"`, and otherwise call `startDirectTmux()`. Remove the `nativeChatEnabled` import. Delete `nativeChatEnabled()` and its `KOBE_TUI` comment block from `src/env.ts`.

```ts
import type { LaunchMode } from "../launch-mode.ts"

export async function startTui(mode: LaunchMode): Promise<void> {
  publishKobeTerminalTitle()
  maybeHintSkillInstall()
  if (mode === "puretui") {
    const { startWorkspaceHost } = await import("../tui-react/workspace/host.tsx")
    await startWorkspaceHost()
    return
  }
  const { startDirectTmux } = await import("./direct")
  await startDirectTmux()
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `cd packages/kobe && bun run test:fast test/tui/start-tui.test.ts test/cli/index-dispatch.test.ts`

Expected: host selection and CLI dispatch pass.

- [ ] **Step 5: Commit the bootstrap slice**

```bash
git add packages/kobe/src/tui/index.tsx packages/kobe/src/env.ts packages/kobe/test/tui/start-tui.test.ts
git commit -m "refactor: remove KOBE_TUI launch switch" -m "Pass the selected launch mode explicitly from the CLI into the TUI bootstrap. Remove the global KOBE_TUI environment gate so startup has one source of truth."
```

### Task 3: Forward launch flags through the sandbox script

**Files:**
- Create: `packages/kobe/scripts/dev-sandbox-args.ts`
- Modify: `packages/kobe/scripts/dev-sandbox.ts:1-68`
- Create: `packages/kobe/test/cli/dev-sandbox-args.test.ts`

**Interfaces:**
- Consumes: `parseLaunchRequest` and `LaunchMode` from `packages/kobe/src/launch-mode.ts`.
- Produces: `parseSandboxArgs(args: readonly string[]): { mode: "run" | "reset" | "home"; launchFlag?: "--puretui" | "--tmux" }`.

- [ ] **Step 1: Write failing sandbox argument tests**

```ts
describe("parseSandboxArgs", () => {
  it("defaults to run with the production PureTUI default", () => {
    expect(parseSandboxArgs(["run"])).toEqual({ mode: "run" })
  })

  it.each(["--puretui", "--tmux"] as const)("forwards %s for run", (launchFlag) => {
    expect(parseSandboxArgs(["run", launchFlag])).toEqual({ mode: "run", launchFlag })
  })

  it("keeps reset and home unchanged", () => {
    expect(parseSandboxArgs(["reset"])).toEqual({ mode: "reset" })
    expect(parseSandboxArgs(["home"])).toEqual({ mode: "home" })
  })

  it("rejects a launch flag for reset", () => {
    expect(() => parseSandboxArgs(["reset", "--tmux"])).toThrow("launch flags are valid only for run")
  })

  it("rejects conflicting run flags", () => {
    expect(() => parseSandboxArgs(["run", "--tmux", "--puretui"])).toThrow("cannot be used together")
  })
})
```

- [ ] **Step 2: Run the sandbox parser test and verify RED**

Run: `cd packages/kobe && bun run test:fast test/cli/dev-sandbox-args.test.ts`

Expected: FAIL because `dev-sandbox-args.ts` does not exist.

- [ ] **Step 3: Implement sandbox parsing and child argv forwarding**

Implement `parseSandboxArgs` with an `Error` on invalid combinations. In `dev-sandbox.ts`, catch the error, print `usage: bun run scripts/dev-sandbox.ts [run [--puretui|--tmux]|reset|home]`, and exit 2. Build run argv as:

```ts
const args =
  mode === "reset"
    ? [process.execPath, "./src/cli/index.ts", "kill-sessions"]
    : [process.execPath, "--conditions=browser", "./src/cli/index.ts", ...(parsed.launchFlag ? [parsed.launchFlag] : [])]
```

- [ ] **Step 4: Run the sandbox parser test and verify GREEN**

Run: `cd packages/kobe && bun run test:fast test/cli/dev-sandbox-args.test.ts`

Expected: all sandbox argument cases pass.

- [ ] **Step 5: Verify Bun script argument forwarding against the local toolchain**

Run: `cd packages/kobe && bun run dev:sandbox home`

Expected: prints the sandbox home path and exits 0. Then run the parser-focused test rather than launching an interactive UI in automation.

- [ ] **Step 6: Commit the sandbox slice**

```bash
git add packages/kobe/scripts/dev-sandbox-args.ts packages/kobe/scripts/dev-sandbox.ts packages/kobe/test/cli/dev-sandbox-args.test.ts
git commit -m "feat: select sandbox TUI launch mode" -m "Allow dev:sandbox runs to forward --puretui or --tmux into the production CLI parser. Keep reset and home non-interactive and reject launch flags outside run mode."
```

### Task 4: Synchronize help, behavior coverage, active docs, and release metadata

**Files:**
- Modify: `packages/kobe/src/cli/usage.ts:10-42`
- Modify: `packages/kobe/test/cli/usage.test.ts:50-61`
- Modify: `packages/kobe/test/behavior/tui-title.test.ts:1-45`
- Modify: `packages/kobe/test/behavior/harness.ts:80-100`
- Modify: `packages/kobe/test/behavior/cli-doctor.test.ts:48-75`
- Modify: `packages/kobe/test/behavior/pure-tui-new-task.test.ts:1-5`
- Modify: `CONTEXT.md:1-75,160-210`
- Modify: `docs/ARCHITECTURE.md:190-235`
- Modify: `docs/KEYBINDINGS.md:135-150,365-380`
- Modify: `docs/DESIGN.md:30-42`
- Modify: `docs/design/provider-runtime.md:10-55`
- Modify: `packages/kobe/src/tmux/editor-launch.ts:200-210`
- Modify: `packages/kobe/src/tui-react/workspace/host.tsx:1-8`
- Modify: `packages/kobe/src/tui-react/panes/terminal/Terminal.tsx:1-10`
- Modify: `packages/kobe/src/tui/i18n/messages/workspace.ts:1-5`
- Modify: `packages/kobe/src/tui/panes/terminal/CLAUDE.md:25-35`
- Create: `.changeset/puretui-default-launch.md`

**Interfaces:**
- Consumes: the final CLI contract from Tasks 1-3.
- Produces: synchronized human-facing help, active documentation, behavior fixtures, and patch release note.

- [ ] **Step 1: Make help tests fail on the missing launch contract**

Add assertions that help says bare `kobe` launches PureTUI and contains both `--puretui` and `--tmux`.

```ts
it("documents the PureTUI default and launch overrides", () => {
  expect(usage).toContain("launch PureTUI")
  expect(usage).toContain("--puretui")
  expect(usage).toContain("--tmux")
})
```

- [ ] **Step 2: Run the help test and verify RED**

Run: `cd packages/kobe && bun run test:fast test/cli/usage.test.ts`

Expected: FAIL because current help only says “launch the TUI” and lists neither flag.

- [ ] **Step 3: Update top-level help**

Change the usage introduction to `Run with no command to launch PureTUI.` and add:

```text
  --puretui               Launch the PureTUI workspace (default)
  --tmux                  Launch the tmux Handover workspace
```

- [ ] **Step 4: Run help and CLI dispatch tests and verify GREEN**

Run: `cd packages/kobe && bun run test:fast test/cli/usage.test.ts test/cli/index-dispatch.test.ts`

Expected: both files pass and the conflict path prints the updated help.

- [ ] **Step 5: Update behavior fixtures and active documentation**

Launch the title behavior child as `nodePty.spawn("bun", [DIST_CLI, "--puretui"], ...)` without `KOBE_TUI`. Remove `KOBE_TUI` from the poisoned-env fixture and rewrite comments that describe ambient PureTUI selection. Replace active `KOBE_TUI=1` names with “PureTUI Workspace Host” and update `CONTEXT.md`/`ARCHITECTURE.md` to make PureTUI the default and `kobe --tmux` the Handover override. Preserve historical release entries in `packages/kobe/CHANGELOG.md`; they describe behavior at the time shipped.

- [ ] **Step 6: Add the patch changeset**

```md
---
"@sma1lboy/kobe": patch
---

Make the PureTUI Workspace Host the default `kobe` interface, add explicit `--puretui` and `--tmux` launch flags, remove the `KOBE_TUI` environment switch, and let development sandbox runs select either interface with the same flags.
```

- [ ] **Step 7: Prove no active runtime reference remains**

Run: `rg -n "KOBE_TUI|nativeChatEnabled" packages/kobe/src packages/kobe/scripts packages/kobe/test CONTEXT.md docs/ARCHITECTURE.md docs/KEYBINDINGS.md docs/DESIGN.md docs/design/provider-runtime.md`

Expected: no matches. Historical `packages/kobe/CHANGELOG.md` and previously committed specs/plans are intentionally outside this active-surface check.

- [ ] **Step 8: Run focused tests and behavior build**

Run:

```bash
cd packages/kobe
bun run test:fast test/cli/launch-mode.test.ts test/cli/index-dispatch.test.ts test/cli/usage.test.ts test/cli/dev-sandbox-args.test.ts test/tui/start-tui.test.ts
bun run build
bun run test:behavior -- test/behavior/tui-title.test.ts
```

Expected: focused unit tests pass; build exits 0; title behavior test passes on platforms with `node-pty` and is explicitly skipped where its native addon is unavailable.

- [ ] **Step 9: Run repository gates**

Run from the repository root:

```bash
bun run lint
bun run typecheck
bun run test
cd packages/kobe && bun run test:behavior
```

Expected: lint, typecheck, fast tests, socket tests, and the complete behavior suite all pass.

- [ ] **Step 10: Inspect scope and commit the release slice**

```bash
git status --short
git diff --check
git diff --stat HEAD~3
git add .changeset/puretui-default-launch.md packages/kobe/src/cli/usage.ts packages/kobe/test/cli/usage.test.ts packages/kobe/test/behavior/tui-title.test.ts packages/kobe/test/behavior/harness.ts packages/kobe/test/behavior/cli-doctor.test.ts packages/kobe/test/behavior/pure-tui-new-task.test.ts CONTEXT.md docs/ARCHITECTURE.md docs/KEYBINDINGS.md docs/DESIGN.md docs/design/provider-runtime.md packages/kobe/src/tmux/editor-launch.ts packages/kobe/src/tui-react/workspace/host.tsx packages/kobe/src/tui-react/panes/terminal/Terminal.tsx packages/kobe/src/tui/i18n/messages/workspace.ts packages/kobe/src/tui/panes/terminal/CLAUDE.md
git commit -m "docs: make PureTUI the documented default" -m "Synchronize CLI help, active architecture docs, behavior fixtures, and release metadata with the new launch contract. Preserve historical changelog entries while removing KOBE_TUI from active product surfaces."
```

### Task 5: Final verification and branch handoff

**Files:**
- Verify only; no planned file edits.

**Interfaces:**
- Consumes: all deliverables from Tasks 1-4.
- Produces: evidence that the branch is ready for PR review without staging unrelated user files.

- [ ] **Step 1: Verify branch scope and commit history**

Run:

```bash
git status --short --branch
git log --oneline --decorate origin/main..HEAD
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
```

Expected: only `.agents/skills/brand-studio` and `.planning/` remain as unrelated working-tree changes; the feature diff contains the design, plan, implementation, tests, active docs, and one patch changeset.

- [ ] **Step 2: Re-run the full release gate from a fresh command**

Run:

```bash
bun run lint && bun run typecheck && bun run test && (cd packages/kobe && bun run build && bun run test:behavior)
```

Expected: every command exits 0.

- [ ] **Step 3: Report exact usage and verification evidence**

Report:

```text
kobe                 -> PureTUI
kobe --puretui       -> PureTUI
kobe --tmux          -> tmux Handover
bun run dev:sandbox --puretui|--tmux -> same explicit selection in isolated state
```

Include the final branch name, commit list, test commands, and note that unrelated `.agents/skills/brand-studio` / `.planning/` changes were not staged.
