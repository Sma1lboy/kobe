# PureTUI Replay ClaudeX Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent monochrome Brand Studio captures by excluding `NO_COLOR`, launch the reviewed Claude task through the user's real `claudex` path, and prove the rendered Claude frame contains its expected colors.

**Architecture:** Keep the fix inside `packages/branding`: sanitize the capture-only child environment and persist an optional recording-only Claude command into the isolated Kobe state. The replay JSON remains portable; the machine-specific `claudex` expansion enters through `KOBE_REPLAY_CLAUDE_COMMAND` only for the reviewed capture invocation.

**Tech Stack:** TypeScript, Bun test, Node PTY sidecar, `@xterm/headless`, OpenTUI, Remotion, ffmpeg.

## Global Constraints

- Do not change the user's shell alias, provider configuration, global Kobe state, or normal engine defaults.
- Do not put machine-specific `claudex`, model, or provider values in `quicklook.replay.json`.
- The reviewed Claude frame must visibly contain Claude orange `rgb(215,119,87)`, warning yellow `rgb(255,193,7)`, muted gray, and a dark background.
- A real but monochrome Claude frame fails acceptance.
- Keep every touched source file at or below 500 lines.
- Use no subagents; execute this plan inline.

---

### Task 1: Sanitize the Capture Color Environment

**Files:**
- Modify: `packages/branding/tests/puretui-terminal.test.ts`
- Modify: `packages/branding/src/quicklook/puretui-terminal.ts:51-65`

**Interfaces:**
- Consumes: `createPureTuiCapture(options: PureTuiCaptureOptions)` and its `SidecarFactory` injection.
- Produces: a sidecar spawn environment that never contains `NO_COLOR` and still declares `TERM=xterm-256color` plus `COLORTERM=truecolor`.

- [ ] **Step 1: Write the failing environment-boundary test**

Add a focused test that temporarily sets `process.env.NO_COLOR = "1"`, creates a capture with the existing fake sidecar, and asserts:

```ts
expect(sidecarFactory.calls[0].env).not.toHaveProperty("NO_COLOR")
expect(sidecarFactory.calls[0].env).toMatchObject({
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
})
```

Restore the previous process environment in `finally` and call capture cleanup.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cd packages/branding
bun test tests/puretui-terminal.test.ts -t "does not inherit NO_COLOR"
```

Expected: FAIL because the sidecar environment currently contains `NO_COLOR: "1"`.

- [ ] **Step 3: Implement the minimal environment filter**

Extend the existing `inheritedEnvironment()` predicate in `puretui-terminal.ts` with:

```ts
key !== "NO_COLOR"
```

Do not introduce a new environment builder or alter normal Kobe runtime code.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same focused command. Expected: PASS.

### Task 2: Add a Capture-Only Claude Command Override

**Files:**
- Modify: `packages/branding/tests/puretui-terminal.test.ts`
- Modify: `packages/branding/scripts/capture-puretui.ts`

**Interfaces:**
- Consumes: optional `CapturePureTuiOptions.claudeCommand?: string`.
- Produces: `engineCommand.claude` in `<demoRoot>/home/.config/kobe/state.json` only when the option is non-empty.
- CLI source: `process.env.KOBE_REPLAY_CLAUDE_COMMAND?.trim()`.

- [ ] **Step 1: Write failing state tests**

Keep the existing no-override assertion exactly unchanged, then add a second capture CLI test that passes:

```ts
claudeCommand: "/usr/bin/env TEST_CAPTURE=1 claude --model test"
```

After the zero-second injected capture completes, assert the isolated state contains:

```ts
expect(state["engineCommand.claude"]).toBe(
  "/usr/bin/env TEST_CAPTURE=1 claude --model test",
)
```

- [ ] **Step 2: Run the focused CLI tests and verify RED**

Run:

```bash
cd packages/branding
bun test tests/puretui-terminal.test.ts -t "Claude command override"
```

Expected: TypeScript/runtime assertion failure because `claudeCommand` is not accepted or persisted.

- [ ] **Step 3: Implement minimal option and persistence**

Add the optional field:

```ts
claudeCommand?: string
```

Build the isolated state before writing it:

```ts
const state: Record<string, unknown> = {
  onboarded: true,
  skillHintSeen: "1",
  savedRepos: [fixtureRepo],
}
const claudeCommand = options.claudeCommand?.trim()
if (claudeCommand) state["engineCommand.claude"] = claudeCommand
```

Pass the value into `prepareCaptureState`. In `parseArguments`, populate it from:

```ts
process.env.KOBE_REPLAY_CLAUDE_COMMAND?.trim() || undefined
```

- [ ] **Step 4: Run focused and replay tests and verify GREEN**

Run:

```bash
cd packages/branding
bun test tests/puretui-terminal.test.ts
bun run test:replay
```

Expected: all tests pass; the opt-in real capture test remains skipped.

### Task 3: Record Through the Real ClaudeX Launch Path

**Files:**
- Regenerate: `packages/branding/src/quicklook/frames.json`
- Generate for review: `packages/branding/out/kobe-quicklook-4x.mp4`

**Interfaces:**
- Consumes: current `claudex` alias expansion reported by `zsh -lic 'alias claudex'`.
- Produces: an isolated replay whose Claude task command uses the equivalent `/usr/bin/env ... cc-switch start claude cliproxy-local -- --model fable` launch.

- [ ] **Step 1: Resolve the current alias and authoritative command paths**

Run:

```bash
zsh -lic 'alias claudex; command -v cc-switch; command -v claude'
```

Construct the override from the current alias expansion using absolute `cc-switch` path and the same four environment variables. Do not write secrets or provider configuration into the repository.

- [ ] **Step 2: Capture to a review file with the override**

From `packages/branding`, run `bun run capture:puretui` with `KOBE_REPLAY_CLAUDE_COMMAND` set to the resolved command, `--output /tmp/kobe-quicklook-frames-claudex-color.json`, and `--keep-demo-root`.

Expected: capture completes with a retained isolated demo root and current ClaudeX model visible in its Claude frames.

- [ ] **Step 3: Prove the captured ANSI contains Claude colors**

Parse the review JSON and require occurrences of:

```text
38;2;215;119;87
38;2;255;193;7
38;2;153;153;153 (or another explicit muted gray emitted by ClaudeX)
```

Also verify the recorded Claude pane identifies Claude Code and the current ClaudeX model. Do not promote a file that lacks these signals.

- [ ] **Step 4: Promote and render**

Mechanically copy the reviewed JSON to `src/quicklook/frames.json`, then run:

```bash
bun x remotion render src/index.ts quicklook-replay-4x out/kobe-quicklook-4x.mp4
```

Expected: 1280x720 MP4 renders successfully.

### Task 4: Visual Acceptance and Repository Verification

**Files:**
- Generate for review: `packages/branding/out/kobe-quicklook-claudex-color-confirmed.png`

**Interfaces:**
- Consumes: the final MP4 and refreshed frames.
- Produces: one stable Claude frame that directly proves the requested palette.

- [ ] **Step 1: Extract candidate Claude frames**

Use `ffmpeg` to extract multiple frames during the Claude stage, including after prompt submission. Select the frame with visible Claude orange, warning yellow, muted gray, white text, and dark background.

- [ ] **Step 2: Inspect the selected frame at original resolution**

Use the local image viewer and reject it if Claude content is monochrome, clipped beyond recognition, or actually a bare `claude` launch rather than ClaudeX.

- [ ] **Step 3: Run complete verification**

Run:

```bash
bun run lint
bun run typecheck
bun run test
cd packages/kobe && bun run build && bun run test:behavior
cd ../branding && bun run test:replay
git diff --check
```

Expected: all scoped and repository checks pass. Keep the previously documented unrelated stale Kanban visual baseline outside this slice.

- [ ] **Step 4: Commit, push, and watch PR checks**

Stage only the capture implementation, tests, refreshed frames, plan/spec documents, and changeset if needed. Commit with a direct fix message, push the existing branch, then wait for every PR #324 check to complete successfully.

- [ ] **Step 5: Reveal artifacts and complete the goal**

Open the confirmed PNG and reveal the MP4 in Finder. Mark the goal complete only after the image, ANSI evidence, tests, and PR checks all prove the objective.
