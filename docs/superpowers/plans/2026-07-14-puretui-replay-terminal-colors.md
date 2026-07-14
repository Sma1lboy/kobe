# PureTUI Replay Terminal Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore bidirectional default-color negotiation in native replay capture and produce a visually verified current Brand Studio frame.

**Architecture:** A focused capture-side helper registers OSC 10/11 handlers on `@xterm/headless` and emits standards-compatible RGB replies through the same PTY input channel as other xterm responses. The replay theme is passed through the existing JSON sidecar start request so capture and render share one declared palette.

**Tech Stack:** Bun, Node, `node-pty`, `@xterm/headless` 6, TypeScript, `bun:test`, Remotion, `/harness`.

## Global Constraints

- Keep capture-specific behavior in `packages/branding`; do not add Remotion concerns to Kobe runtime packages.
- Use the validated replay theme as the terminal default-color source.
- Never answer queries while replaying historical PTY bytes.
- Do not change keybindings or product layout.
- Keep every touched source file at or below the repository's approximately 500-line cap.

---

### Task 1: Prove the missing terminal replies

**Files:**
- Create: `packages/branding/tests/puretui-terminal-colors.test.ts`
- Modify: `packages/branding/scripts/puretui-pty-sidecar.mjs`

**Interfaces:**
- Produces `registerDefaultColorHandlers(terminal, theme, reply)`.
- The callback receives exact terminal input bytes to write to the PTY.

- [ ] **Step 1: Write failing OSC and forwarding tests**

Create tests that instantiate a real headless xterm, register the wished-for
helper, write `\x1b]10;?\x07\x1b]11;?\x07`, and expect:

```ts
expect(replies).toEqual([
  "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
  "\x1b]11;rgb:1414/1414/1313\x1b\\",
])
```

Add a controller test whose fake terminal fires `onData("\x1b[1;1R")` and
asserts the fake child receives that exact input.

- [ ] **Step 2: Run the test and verify RED**

Run: `bun test packages/branding/tests/puretui-terminal-colors.test.ts`

Expected: FAIL because the helper is not exported and controller does not
subscribe to terminal replies.

- [ ] **Step 3: Implement the minimal capture-side protocol**

Add a strict `#RRGGBB` to 16-bit OSC encoder, register query-only handlers for
slots 10 and 11, subscribe to `terminal.onData`, and write replies only while
the child is alive. Do not intercept color-set payloads.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `bun test packages/branding/tests/puretui-terminal-colors.test.ts packages/branding/tests/puretui-terminal.test.ts`

Expected: both files pass with zero failures.

### Task 2: Carry the declared replay theme into the sidecar

**Files:**
- Modify: `packages/branding/src/quicklook/puretui-terminal.ts`
- Modify: `packages/branding/scripts/capture-puretui.ts`
- Test: `packages/branding/tests/puretui-terminal-colors.test.ts`

**Interfaces:**
- `PureTuiCaptureOptions` gains `theme: Pick<TerminalTheme, "defaultFg" | "defaultBg">`.
- `PureTuiTerminal.start()` includes that theme in the existing `start` request.

- [ ] **Step 1: Add a failing request-contract test**

Assert the first sidecar request contains:

```ts
theme: { defaultFg: "#FFFFFF", defaultBg: "#141413" }
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test packages/branding/tests/puretui-terminal-colors.test.ts`

Expected: FAIL because the theme is absent from the request.

- [ ] **Step 3: Thread the validated theme through capture creation**

Pass `spec.theme` from `capturePureTui` into `createPureTuiCapture`; include it
in the start request and require it before constructing the sidecar xterm.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `bun test packages/branding/tests/puretui-terminal-colors.test.ts packages/branding/tests/puretui-terminal.test.ts`

Expected: all tests pass.

### Task 3: Verify and produce the accepted artifact

**Files:**
- Modify: `packages/branding/src/quicklook/frames.json`
- Scratch only: `packages/branding/out/kobe-quicklook-4x.mp4`
- Scratch only: `/tmp/kobe-replay-color-after.png`

- [ ] **Step 1: Run code verification**

Run the branding replay tests, package typechecks, repository lint, typecheck,
test, build, and behavior checks. Every command must exit zero.

- [ ] **Step 2: Capture the `/harness` visual baseline**

Open the fixed viewport `/harness`, wait for real OpenTUI and the native agent,
then save a screenshot showing the workspace, agent pane, and surrounding
chrome.

- [ ] **Step 3: Record and render in the feature worktree**

Run `bun run capture:puretui` from `packages/branding`, then render
`quicklook-replay-4x` to `packages/branding/out/kobe-quicklook-4x.mp4` in the
same worktree.

- [ ] **Step 4: Extract and inspect a representative frame**

Use ffmpeg to extract an agent-visible frame. Confirm current version/content,
the replay theme background, readable default text, distinct accent/warning
colors, and no stale tmux status line.

- [ ] **Step 5: Commit and update the existing PR**

Stage only the color fix, tests, docs, and regenerated frames; commit through
ordinary git CLI, push the feature branch, and confirm PR checks.
