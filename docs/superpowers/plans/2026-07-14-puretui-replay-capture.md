# PureTUI Replay Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a Brand Studio-consumable `frames.json` from a real, isolated PureTUI + Hosted PTY run.

**Architecture:** `packages/branding` gains a backend-neutral capture core that interprets the existing replay spec through a small terminal adapter. The production adapter launches the supported `kobe dev:sandbox` entrypoint inside a unique home and uses a PTY plus xterm-headless to inject input and snapshot the actual OpenTUI screen; tests use an in-memory adapter. The existing Remotion renderer remains the sole consumer of the checked-in ANSI capture.

**Tech Stack:** Bun, TypeScript, `node-pty`, `@xterm/headless`, `bun:test`, existing Kobe `dev:sandbox`, Remotion 4.

## Global Constraints

- Keep all capture, replay, and Remotion code in `packages/branding`; do not introduce marketing dependencies in `packages/kobe` or `packages/kobe-daemon`.
- Start every production capture with a unique `KOBE_SANDBOX_HOME_DIR`/`KOBE_HOME_DIR`, repository fixture, host identity, and session identity; never use normal `~/.kobe` state.
- The capture driver may remove only the demo root it created after proving every child has exited; preserve that root on failure and never replace `frames.json` on failure.
- Treat `quicklook.replay.json` as the editable storyboard. Reject unknown action, text, wait, flow, region, stage boundary, and invalid capture geometry before starting a child process.
- Store frames only when the rendered terminal state changes, using elapsed wall-clock time rather than nominal beat time; publish the output with a same-directory atomic rename.
- Do not add or move keybindings. Use the spec's declared keys and interstitial dismissal rules verbatim.
- Keep source files at or below the repository's approximately 500-line cap.

---

## File structure

- `packages/branding/src/quicklook/replay-spec.ts` — validates the storyboard and exposes the fully resolved, capture-safe spec shared by the renderer and the driver.
- `packages/branding/src/quicklook/capture-core.ts` — backend-neutral terminal, clock, filesystem, and process-lifecycle interfaces plus the beat interpreter and atomic capture writer.
- `packages/branding/src/quicklook/puretui-terminal.ts` — production adapter that launches the actual `dev:sandbox` TUI in a `node-pty`, feeds output into xterm-headless, supplies snapshots, and terminates the process tree.
- `packages/branding/scripts/capture-puretui.ts` — thin CLI composition root: creates the disposable demo environment, validates the spec, wires the real adapter/core, and prints useful diagnostic paths.
- `packages/branding/tests/replay-spec.test.ts` — regression tests for invalid capture references and action grammar.
- `packages/branding/tests/capture-core.test.ts` — deterministic fake-adapter tests for typing, waits, timestamps, atomic output, and failure/success teardown.
- `packages/branding/tests/puretui-capture.test.ts` — opt-in bounded end-to-end smoke capture using the actual sandbox and a disposable fixture repository.
- `packages/branding/package.json` — declares direct capture dependencies and reproducible test/capture scripts.

### Task 1: Make the replay spec an executable capture contract

**Files:**
- Modify: `packages/branding/src/quicklook/replay-spec.ts:1-340`
- Modify: `packages/branding/tests/replay-spec.test.ts:1-133`

**Interfaces:**
- Produces `ResolvedReplaySpec`, where each `ReplayBeat.action` is one of `"typeText" | "typeTextWhenReady" | "key" | "flow" | "sleep"` and each `flow` resolves to an existing named flow.
- Consumes the historical `CaptureMeta` shape `{ cols: number; rows: number; frames: Array<{ t: number; lines: unknown[] }> }` without changing renderer compatibility.

- [ ] **Step 1: Write failing validation tests**

Add the following tests to `packages/branding/tests/replay-spec.test.ts`:

```ts
test("rejects unsupported capture actions and missing flow names", () => {
  expect(() => resolveReplaySpec({ ...baseSpec, beats: [{ at: 0, action: "mouse" }] }, capture)).toThrow(
    /unsupported action "mouse"/,
  )
  expect(() => resolveReplaySpec({ ...baseSpec, beats: [{ at: 0, action: "flow", flow: "missing" }] }, capture)).toThrow(
    /unknown flow "missing"/,
  )
})
```

- [ ] **Step 2: Verify the tests fail for the missing contract checks**

Run: `bun test packages/branding/tests/replay-spec.test.ts`

Expected: the new assertions fail because `resolveReplaySpec` currently accepts an arbitrary action and does not reject a missing `flow`.

- [ ] **Step 3: Implement the minimum validation**

In `replay-spec.ts`, introduce the allowed action set and validate the action-specific fields inside the existing beat loop:

```ts
const REPLAY_ACTIONS = new Set<ReplayBeat["action"]>(["typeText", "typeTextWhenReady", "key", "flow", "sleep"])

if (!REPLAY_ACTIONS.has(beat.action)) throw new Error(`beat ${i} has unsupported action "${beat.action}"`)
if (beat.action === "flow" && (beat.flow !== "createTask" || !spec.flows?.createTask)) {
  throw new Error(`beat ${i} references unknown flow "${beat.flow ?? ""}"`)
}
```

Keep the existing `textRef`, `waitFor`, region, and stage checks; add the analogous non-empty `key` check for `key` beats and finite non-negative `ms` check for `sleep` beats.

- [ ] **Step 4: Verify the replay-spec contract is green**

Run: `bun test packages/branding/tests/replay-spec.test.ts`

Expected: all replay-spec tests pass, including the two new negative cases.

- [ ] **Step 5: Commit the independently reviewable contract change**

```bash
git add packages/branding/src/quicklook/replay-spec.ts packages/branding/tests/replay-spec.test.ts
git commit -m "test: validate replay capture actions"
```

### Task 2: Build and prove the backend-neutral capture interpreter

**Files:**
- Create: `packages/branding/src/quicklook/capture-core.ts`
- Create: `packages/branding/tests/capture-core.test.ts`

**Interfaces:**
- Consumes `ResolvedReplaySpec` from Task 1 and a `CaptureTerminal` with `snapshot()`, `type()`, `key()`, `waitFor()`, `start()`, and `stop()`.
- Produces `runReplayCapture(spec, terminal, output, clock): Promise<CaptureDocument>` and `writeCaptureAtomically(path, capture): Promise<void>`.
- `CaptureDocument` has `{ cols, rows, frames, meta }`, with non-empty monotonic `frames` and `meta.theme` copied from the spec when defined.

- [ ] **Step 1: Write failing fake-terminal tests**

Create `capture-core.test.ts` with a fake terminal that records calls and exposes a queue of ANSI screens. Cover the required behaviors:

```ts
test("captures only changed screens with elapsed wall-clock timestamps", async () => {
  const result = await runReplayCapture(spec, fake(["boot", "boot", "dialog"]), memoryOutput, clock([100, 140, 225]))
  expect(result.frames.map((frame) => [frame.t, frame.lines])).toEqual([[0, ["boot"]], [0.125, ["dialog"]]])
})

test("stops the terminal and leaves the previous output untouched when a beat fails", async () => {
  await expect(runReplayCapture(spec, failingFake, output, clock([0]))).rejects.toThrow("composer timeout")
  expect(failingFake.stopCalls).toBe(1)
  expect(output.writes).toEqual([])
})
```

Also add focused cases for per-character typing plus submit delay, `typeTextWhenReady`, named `createTask` flow expansion, and same-directory temp-file rename.

- [ ] **Step 2: Verify the new tests fail before implementation exists**

Run: `bun test packages/branding/tests/capture-core.test.ts`

Expected: failure because `capture-core.ts` and `runReplayCapture` do not exist.

- [ ] **Step 3: Implement the core in focused units**

Define these public shapes in `capture-core.ts`:

```ts
export interface CaptureTerminal {
  start(): Promise<void>
  snapshot(): Promise<readonly string[]>
  type(text: string): Promise<void>
  key(key: string): Promise<void>
  waitFor(pattern: string, timeoutMs: number): Promise<void>
  stop(): Promise<void>
}
export interface CaptureClock { now(): number; sleep(ms: number): Promise<void> }
export async function runReplayCapture(spec: ResolvedReplaySpec, terminal: CaptureTerminal, output: CaptureOutput, clock: CaptureClock): Promise<CaptureDocument>
```

Start the terminal only after the resolved spec is supplied. Capture its initial snapshot at `t: 0`; after every emitted key, typed character, wait completion, and declared settle/sleep, snapshot and append only if the line array differs from the last frame. Execute each beat in chronological order, sleeping only the positive delta from the previous nominal beat. In a `try/finally`, call `terminal.stop()` exactly once. Call `output.replaceAtomically(document)` only after all beats and final schema validation complete.

- [ ] **Step 4: Verify the core behavior is green**

Run: `bun test packages/branding/tests/capture-core.test.ts`

Expected: all fake-adapter cases pass with no filesystem or process dependency.

- [ ] **Step 5: Commit the capture core**

```bash
git add packages/branding/src/quicklook/capture-core.ts packages/branding/tests/capture-core.test.ts
git commit -m "feat: add replay capture interpreter"
```

### Task 3: Add the real PureTUI terminal adapter and isolated launcher

**Files:**
- Create: `packages/branding/src/quicklook/puretui-terminal.ts`
- Create: `packages/branding/scripts/capture-puretui.ts`
- Create: `packages/branding/tests/puretui-terminal.test.ts`
- Modify: `packages/branding/package.json`

**Interfaces:**
- Implements Task 2's `CaptureTerminal` as `PureTuiTerminal`.
- `createPureTuiCapture(options): Promise<{ terminal: CaptureTerminal; cleanup(): Promise<void>; demoRoot: string }>` creates all disposable files under `options.demoRoot`.
- The CLI accepts `--spec <path>`, `--output <path>`, `--keep-demo-root`, and `--timeout-ms`, defaulting to the existing QuickLook paths.

- [ ] **Step 1: Write the failing adapter tests around process construction and teardown**

Create test doubles for the PTY factory and filesystem wrapper, then assert:

```ts
test("launches dev:sandbox with an isolated home and fixed replay viewport", async () => {
  const capture = await createPureTuiCapture({ repoRoot, demoRoot, cols: 160, rows: 45, ptyFactory })
  expect(ptyFactory.calls[0]).toMatchObject({
    file: "bun",
    args: ["run", "dev:sandbox"],
    options: { cols: 160, rows: 45, env: expect.objectContaining({ KOBE_SANDBOX_HOME_DIR: expect.stringContaining(demoRoot) }) },
  })
  await capture.cleanup()
})
```

Add a timeout test that requires the thrown error to include the latest ANSI snapshot, child pid, and demo root, and a teardown test that asserts `dev:sandbox:reset` runs before the temporary root is removed.

- [ ] **Step 2: Verify the adapter tests fail**

Run: `bun test packages/branding/tests/puretui-terminal.test.ts`

Expected: failure because the production adapter and its injectable factory are absent.

- [ ] **Step 3: Implement the production adapter without changing product code**

Use a lazy `node-pty` import to launch `bun run dev:sandbox` with `cwd: <repoRoot>/packages/kobe`, `cols/rows` from the spec, and a child-only environment containing a unique `KOBE_SANDBOX_HOME_DIR`, `KOBE_HOME_DIR`, `KOBE_DAEMON_WEB_PORT`, and capture-specific host/session labels. Feed `onData` output to `@xterm/headless`, retain raw ANSI for diagnostics, and implement `snapshot()` by serializing the active buffer to stable `rows` lines.

Map declared strings such as `Enter`, `Escape`, `C-h`, and `C-e` to their terminal byte sequences in one `encodeKey()` function. `waitFor()` must poll the rendered snapshot until the declared pattern appears or timeout; it must never use a fixed boot sleep. `stop()` sends a cooperative interrupt, waits for the PTY child to exit, runs `bun run dev:sandbox:reset` with the exact same isolated-home environment, and fails if the child remains alive.

In `capture-puretui.ts`, resolve paths from the branding package, call `resolveReplaySpec` before `createPureTuiCapture`, create the fixture git repository below the demo root, invoke `runReplayCapture`, and print the output path plus retained demo root. Add `capture:puretui` and `test:replay` scripts and direct `node-pty`/`@xterm/headless` dependencies to `packages/branding/package.json`.

- [ ] **Step 4: Verify the adapter unit tests pass**

Run: `bun test packages/branding/tests/puretui-terminal.test.ts`

Expected: all fake-process tests pass; no real daemon or engine is launched.

- [ ] **Step 5: Commit the runnable adapter**

```bash
git add packages/branding/src/quicklook/puretui-terminal.ts packages/branding/scripts/capture-puretui.ts packages/branding/package.json packages/branding/tests/puretui-terminal.test.ts bun.lock
git commit -m "feat: capture PureTUI replay frames"
```

### Task 4: Prove the real capture and renderer boundary

**Files:**
- Create: `packages/branding/tests/puretui-capture.test.ts`
- Modify: `packages/branding/src/quicklook/QuickLookReplay.tsx:1-239`

**Interfaces:**
- Consumes the capture document from Task 2 and the standard `frames.json` shape already loaded by `QuickLookReplay.tsx`.
- Produces a bounded opt-in end-to-end test and early renderer errors for empty/malformed captures.

- [ ] **Step 1: Write failing renderer/capture-boundary tests**

Add an opt-in `KOBE_REPLAY_E2E=1` test that runs a short fixture spec with one task-creation beat and one prompt beat, then asserts the temporary output has ordered frames containing both `"New task"` and the prompt text. Add a renderer validation test that calls the capture validation helper with `{ cols: 160, rows: 45, frames: [] }` and expects `/at least one frame/`.

- [ ] **Step 2: Verify the unit portion fails before the validation is added**

Run: `bun test packages/branding/tests/puretui-capture.test.ts`

Expected: the empty-capture assertion fails because the renderer currently indexes `capture.frames[0]` without a guard; the end-to-end case remains skipped unless `KOBE_REPLAY_E2E=1` is set.

- [ ] **Step 3: Add explicit capture preflight and bounded smoke capture**

Extract `assertRenderableCapture(capture)` from `QuickLookReplay.tsx` into `replay-spec.ts` or a small `capture-document.ts` helper. It must require positive finite `cols/rows`, a non-empty frame array, finite monotonic timestamps, and exactly `rows` serializable lines per frame. Invoke it before the renderer derives dimensions or calls `frameAt`.

Keep the end-to-end fixture under the test temporary directory. It must use a fake engine shim supplied on `PATH`, run with a hard timeout, call the capture CLI with a temp output path, and finally assert the isolated daemon/PTY sockets no longer exist. Do not overwrite the checked-in `frames.json` during tests.

- [ ] **Step 4: Verify unit and bounded end-to-end behavior**

Run unit boundary checks: `bun test packages/branding/tests/replay-spec.test.ts packages/branding/tests/capture-core.test.ts packages/branding/tests/puretui-terminal.test.ts packages/branding/tests/puretui-capture.test.ts`

Run the real smoke capture: `KOBE_REPLAY_E2E=1 bun test packages/branding/tests/puretui-capture.test.ts`

Expected: all unit tests pass; the opt-in test produces a non-empty temporary ANSI capture with the expected create-task and prompt beats and leaves no isolated daemon/PTY child.

- [ ] **Step 5: Commit the end-to-end boundary proof**

```bash
git add packages/branding/src/quicklook/QuickLookReplay.tsx packages/branding/src/quicklook/replay-spec.ts packages/branding/tests/puretui-capture.test.ts
git commit -m "test: verify PureTUI replay capture"
```

### Task 5: Recapture QuickLook and verify Brand Studio consumption

**Files:**
- Modify: `packages/branding/src/quicklook/frames.json`
- Modify: `packages/branding/src/quicklook/quicklook.replay.json` only if the live UI invalidates an explicitly declared wait, region hash, or flow beat.

**Interfaces:**
- Consumes `bun run capture:puretui` from Task 3 and `QuickLookReplay`'s existing `quicklook-replay-1x` / `quicklook-replay-4x` compositions.
- Produces checked-in current ANSI frames; rendered MP4 files remain scratch outputs until separately accepted by Brand Studio.

- [ ] **Step 1: Run a clean real capture into a review file**

Run: `cd packages/branding && bun run capture:puretui --output /tmp/kobe-quicklook-frames.json --keep-demo-root`

Expected: successful validation, current `New task` and prompt beats, monotonically timed frames, and a printed isolated demo root for inspection.

- [ ] **Step 2: Review the captured contract before promotion**

Run: `bun -e 'const x = await Bun.file("/tmp/kobe-quicklook-frames.json").json(); if (!x.frames?.length) throw new Error("empty capture"); console.log({ cols: x.cols, rows: x.rows, frames: x.frames.length, duration: x.frames.at(-1).t })'`

Expected: `cols: 160`, `rows: 45`, a positive frame count, and a positive final timestamp. If a declared readiness marker or coordinate hash is stale, update only the corresponding spec field, rerun Task 1 tests, and repeat the review capture.

- [ ] **Step 3: Atomically promote the reviewed frame set**

Run: `cp /tmp/kobe-quicklook-frames.json packages/branding/src/quicklook/frames.json`

Expected: exactly the reviewed capture becomes the checked-in replay input; no rendered media is added to `public/assets/video/` or accepted state.

- [ ] **Step 4: Render and inspect Brand Studio inputs**

Run:

```bash
cd packages/branding
bun x remotion render src/index.ts quicklook-replay-1x /tmp/kobe-quicklook-1x.mp4
bun x remotion render src/index.ts quicklook-replay-4x /tmp/kobe-quicklook-4x.mp4
ffprobe -v error -show_entries format=duration -of default=nw=1 /tmp/kobe-quicklook-1x.mp4 /tmp/kobe-quicklook-4x.mp4
```

Expected: both renders complete; first, middle, and final frames show readable terminal content and no black region outside the terminal grid. Keep both MP4 files in `/tmp` pending human Brand Studio review.

- [ ] **Step 5: Run the repository gates and commit the captured replay**

Run:

```bash
bun test packages/branding/tests
bun run lint
bun run typecheck
git status --short
```

Expected: all branding tests, lint, and typecheck pass; the staged set contains only replay capture source/tests/spec/frame files and the lockfile when dependency resolution changed.

```bash
git add packages/branding/src/quicklook/frames.json packages/branding/src/quicklook/quicklook.replay.json
git commit -m "chore: refresh PureTUI replay capture"
```

## Plan self-review

- Spec coverage: Task 1 validates the spec up front; Task 2 covers beat interpretation, changed-screen wall-clock frames, atomic output, and teardown; Task 3 covers the real PureTUI/Hosted PTY adapter and isolated lifecycle; Task 4 proves cleanup and renderer rejection; Task 5 recaptures and renders the Brand Studio input.
- Scope: all production additions reside in `packages/branding`; Kobe runtime code is only launched through its supported sandbox entrypoint.
- Terminology/type check: the core exports `CaptureTerminal`, `CaptureClock`, `CaptureDocument`, and `runReplayCapture`; Tasks 3–5 consume those exact names.
- Placeholder scan: no deferred implementation markers remain; each code change identifies an exact path, behavior, test, and command.
