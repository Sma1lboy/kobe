# kobe — Agent Harness

> Read [`PLAN.md`](./PLAN.md) and [`DESIGN.md`](./DESIGN.md) first.
>
> **What this is**: the contract every stream agent and team agent operates under. The point is to let agents self-validate and self-commit in a Ralph Loop, so the human (Jackson) only intervenes on **architectural decisions and blockers**, not on routine "did your code compile" checks.

---

## Principle

> If a fact about your code can be verified by running a command, the agent — not the human — runs that command.

The human's time goes to: design, taste calls, scope decisions, blockers the agent has tried 3+ times to resolve without progress.

The agent's time goes to: write → run → fail → fix → re-run → commit.

This is the Ralph Loop: tight, autonomous, evidence-based iteration.

---

## The five checks (every stream must pass before committing)

Every commit produced by an agent must be preceded by these checks, all green:

```bash
# 1. Type contract
bun run typecheck

# 2. Lint / format
bun run lint        # if a lint script exists; otherwise skip with note

# 3. Unit / component tests for the stream's scope
bun run test         # full suite OR scoped: bun run test src/<stream-dir>

# 4. Smoke test (if the stream produces a runnable artifact)
timeout 5 bun run dev   # exit 0 or 124 (timeout) is OK; 1 is a fail

# 5. *** BEHAVIORAL SELF-TEST *** — the agent runs the actual product and
#     verifies the feature works end-to-end. NO HUMAN IN THE LOOP.
bun run test:behavior   # see §Behavioral self-test below
```

Streams that don't produce runnables (e.g. types-only) skip check 4 and 5.

A stream is **green** when all applicable checks above pass on a clean checkout. The agent commits on green and only on green.

---

## Behavioral self-test — the load-bearing principle

> Unit tests prove the code compiles. Behavioral self-tests prove the *product* works. The agent runs the product itself, drives it, and asserts visible behavior — without asking the human to "click around and check."

This is the single most important property of this harness. If an agent only runs `bun test` and skips behavioral verification, it has not validated its work. It has validated some functions.

### What it looks like

A behavioral test:
1. **Spawns the kobe binary** (or a stream-scoped subset of it) in a controlled environment — PTY or tmux.
2. **Sends inputs** as a real user would: keystrokes, terminal resize events, etc.
3. **Captures the visible screen** at known points (after each input, or after a short settle).
4. **Asserts on visible state**: text present, panes laid out, status badges correct.
5. **Tears down** the process cleanly.

```ts
// example shape — concrete API defined in Stream 0.4
test("sidebar reflects new task immediately", async () => {
  const k = await spawnKobe({ cwd: tmpRepo, fakeEngine: scriptedNoOp });
  await k.sendKeys("n");                            // open new-task dialog
  await k.typeText("test task");
  await k.sendKeys("Enter");
  const screen = await k.capture();
  expect(screen).toContain("test task");
  expect(screen).toContain("In progress");
  await k.exit();
});
```

### Why this is non-negotiable

- The user has explicitly stated: tests must verify *product behavior*, not just *function correctness*. Compilers don't catch "the sidebar doesn't update when a task is created." Behavioral tests do.
- A green typecheck + passing unit tests + broken UX = wasted time. The harness exists to prevent that exact failure mode.
- Without behavioral tests, every stream becomes a coin flip until human review. With them, the agent self-certifies.

### What the harness provides (shipped 2026-07)

- `test/behavior/harness.ts` — black-box driver over the **BUILT** CLI (`dist/cli/index.js`): `makeBehaviorEnv()` (temp `KOBE_HOME` + own tmux sockets + PATH-first `kobe` shim + fake `claude` shim), `runKobe()` (piped CLI runs), `tmux()`/`tmuxInner()`/`waitForScreen()` (send-keys / capture-pane driving — the same pattern the demo-video capture `packages/branding/scripts/capture-tui.ts` uses), `makeScratchRepo()`. Runs dist on purpose: packaged-only code paths (`import.meta.url.endsWith(".js")` branches, PATH resolution) are exactly where dev-only unit runs go blind.
- `bun run test:behavior` — runs every `test/behavior/**/*.test.ts` (`bun run build` first; the harness errors clearly if dist is missing). CI runs it in the dedicated `behavior` job (ubuntu + apt tmux — no real engine needed).
- Current suites: `cli-doctor` (doctor report surface, env isolation, TTY-vs-pipe), `cli-update` (+ the `scripts/update.sh` package-manager matrix, issue #205), `tui-smoke` (boot renders workspace; ctrl+h/l focus + the #192 left-edge no-wrap pin).

Every stream whose "Done when" is user-visible behavior **must** include at least one behavior test that proves it works.

### Regression tests are mandatory on every bug fix (HARD RULE)

A bug fix is not done until the same commit carries a test that **fails before the fix and passes after**, with a comment naming the issue/commit it pins (grep `issue #192` / `#205` in the suites for the shape). "The same bug came back" always means the first fix shipped without its pin. If the bug is environment-shaped (terminal bytes, PATH state, packaged-vs-dev), the pin belongs in `test/behavior/`, not in a mocked unit test — a module mock replaces EVERY export, and a best-effort catch can silently eat the resulting `undefined()` (that exact chain shipped red CI once; see `codex-hook-adapter.test.ts`).

### Coverage gate (per-touched-file, PR CI)

`cd packages/kobe && bun run coverage` writes text + `coverage/coverage-summary.json` (v8). CI's `coverage-cap` job gates PRs: every `packages/kobe/src` file the PR touches must meet the line-coverage floor (default 50%, `scripts/coverage-gate.mjs`); a file absent from the report counts as 0%. Escape hatch: a `coverage-exemption: <reason>` line in the PR body. Deliberately NO repo-wide % threshold — global bars breed filler tests; the per-touched-file floor ratchets coverage exactly where work happens.

### When unit tests are still useful

Behavioral tests are slow (seconds each, not milliseconds) and harder to debug. Use unit tests for:
- Pure logic (parsers, serializers, state machines).
- Edge cases that are tedious to provoke through the UI (corrupt files, missing dirs, ENOENT, etc.).
- Anywhere a behavior test would be flakier or slower without proving more.

Unit tests are necessary. Behavior tests are sufficient.

---

## Performance contracts

Two layers, strictly separated:

- **Counting tests gate CI.** A perf fix's contract is an *operation count* — tmux spawns per session reuse, transcript reads per poll, frame-accessor reads per tick, git runs per tick storm — pinned with injected counting fakes / module mocks at the same seams production injects. See `test/tui/perf-budgets.test.ts` (the budget net, one comment per pinned commit), plus `test/tui/git-head-poller.test.ts`, the turn-detector mtime tests, and the row-identity `toBe` tests. Deterministic, timing-free, safe on any CI runner.
- **Benchmarks are local, opt-in, and never gate.** `bun run bench` (vitest bench, `test/bench/*.bench.ts`) times the hot pure paths — keymap dispatch, porcelain parse, row reconcile, row-view build — as a before/after baseline tool when working on those paths. Bench files never run in `test:fast`/CI: the vitest `test.include` pattern only matches `*.test.ts`.

Never assert wall-clock time in a CI test. Runner jitter makes timing assertions flaky, and a flaky gate is worse than no gate — if a perf property matters, find the operation count that expresses it and count that instead.

---

## The Ralph Loop, formally

```
1. Read inputs (DESIGN.md + PLAN.md stream + upstream commits + refs).
2. Implement the stream's deliverables.
3. Run the four checks.
4. If any fails:
     a. Read the error.
     b. Fix the root cause (no --no-verify, no skipping tests, no try/catch swallowing).
     c. Goto 3.
     d. After 3 consecutive fails on the same root cause, stop and surface — don't spiral.
5. Commit.
6. Report: commit hash + what landed + any deviations + any "Done when" criteria you waived (with reason).
```

The "3-strike rule" is hard. Three failed attempts at the same fix = stop and report, don't keep trying. From CLAUDE.md.

---

## What agents commit

- One commit per stream (squash internally if needed before final commit).
- Commit message format:
  ```
  <type>: <stream id> — <one-line summary>

  <2-3 sentence body: what landed and why this is a complete unit>
  ```
  Where `<type>` is `chore` (scaffolding/config), `feat` (new functionality), `refactor`, `test`, `docs`, `fix`. Match opencode's style.

- **NEVER** include `Co-Authored-By: Claude` or any AI attribution. No "Generated with Claude Code" footers. (From CLAUDE.md.)
- **NEVER** use `--no-verify` or skip hooks. If a hook fails, fix the underlying issue.
- **NEVER** delete files unless the user explicitly said "delete" or "remove" in the brief.

---

## What "Done when" means

Each stream in PLAN.md has a "Done when" line. That clause is **the success contract**.

- The agent must verify each "Done when" sub-clause with a command, not by inspection.
- If a "Done when" clause is ambiguous, the agent surfaces the ambiguity *before* committing — not after.
- "It looks right to me" is not done. "Test X asserts Y and passes" is done.

---

## Surfacing — when and how

Surface to the human (the user, via tool result text) when:

1. **Architectural ambiguity** — design decision not in DESIGN.md or PLAN.md.
2. **3-strike rule fired** — three failed fix attempts on the same root cause.
3. **Cross-stream conflict** — your stream needs a change in another stream's scope.
4. **Deviation from spec** — you intentionally did X instead of what PLAN.md said. Always say so explicitly.
5. **Acceptance waived** — you couldn't satisfy a "Done when" sub-clause and shipped without it. Say which one and why.

Do not surface for:
- Routine compiler errors you fixed.
- Minor file-naming choices within your scope.
- Commit message wording.
- Whether to run `bun install` (just run it).

---

## Team mode

A **team** is two or more agents running the same brief in parallel, each owning a non-overlapping slice. The user prefers teams over solo agents because parallelism compresses wall-clock and avoids serial bottlenecks.

Conventions for teams:

- Each team agent works in its own git worktree (`isolation: "worktree"`) to prevent cross-pollution.
- Each agent's slice is named (`Foundation/0.2`, `Foundation/0.3`, `Wave1/A`, etc.) and surfaces under that name.
- Agents on the same team **must not** edit files in another agent's slice. If they need a change there, they surface for coordination — they do not unilaterally cross the line.
- Each agent commits independently in its worktree branch.
- The orchestrator (the main Claude Code session, i.e. me) merges those branches back into `main` after both agents are green.
- A team is **done** when every member commits green and the orchestrator finishes the merge.

Communication between teammates, when needed, goes through:
- The file system (one team writes a fixture, the other consumes it).
- A shared "team scratchpad" file at `docs/teams/<wave>-<team>.md` (created by the first agent if needed; not committed to main unless useful long-term).
- The orchestrator (me) — explicit handoff via SendMessage if the runtime supports it, otherwise a pause-and-resume.

---

## What the orchestrator (main session) owns

- Spawning team agents with the right brief and `isolation: "worktree"`.
- Verifying the four checks pass on the merged result before declaring a wave done.
- Updating PLAN.md with completed-stream check marks.
- Surfacing wave-level decisions to the user (gate G0, G1, G2, G3, G4 sign-offs).
- Writing the next wave's team briefs after the previous gate is green.

---

## Acceptance summary table

| Stream type | Typecheck | Lint | Tests | Smoke (`dev`) | Commits in worktree |
|---|---|---|---|---|---|
| Bootstrap (0.1) | ✅ | optional | optional (none yet) | ✅ | main |
| Shell lift (0.2) | ✅ | ✅ | optional | ✅ | worktree |
| Types (0.3) | ✅ | ✅ | ✅ (type-level) | n/a | worktree |
| Engine impl (A) | ✅ | ✅ | ✅ (unit + integration) | n/a | worktree |
| Worktree mgr (B) | ✅ | ✅ | ✅ (against fixture repo) | n/a | worktree |
| Task index (C) | ✅ | ✅ | ✅ (CRUD + concurrency) | n/a | worktree |
| Pane streams (F–J) | ✅ | ✅ | ✅ (component) | ✅ | worktree |
| Glue (E) | ✅ | ✅ | ✅ (integration) | ✅ | worktree |
| Polish (K, L, M) | ✅ | ✅ | ✅ | ✅ | worktree |

---

## Anti-patterns the harness exists to prevent

- "I'll skip the test for now, it's just a small change." — No. The check is the contract.
- "The typecheck error is in someone else's code, not mine." — Surface and ask. Don't suppress with `// @ts-ignore`.
- "I committed even though dev crashed because the crash was unrelated." — No. If `bun run dev` fails, the commit fails.
- "I added `--no-verify` to bypass the hook." — Forbidden. Fix the hook or fix the underlying issue.
- "I rewrote the upstream stream's interface to make my impl easier." — Surface and coordinate. Don't unilaterally widen scope.
- "I ran out of ideas after one attempt." — Try at least 2 more before surfacing, but stop at 3.

---

## TL;DR for an agent

> Read DESIGN.md + your PLAN.md stream + this HARNESS.md. Implement. Run typecheck + lint + test + smoke. Loop on failures (max 3 strikes per root cause). Commit on green with a clean message and no AI attribution. Surface architectural calls, cross-stream needs, or 3-strike blockers — nothing else.
