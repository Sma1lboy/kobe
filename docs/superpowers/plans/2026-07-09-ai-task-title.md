# AI Task Title Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace prompt-truncation task titles with a Claude Code-style fallback-plus-async-AI title flow.

**Architecture:** Keep transcript reading in `monitor/auto-title.ts`, add an engine-owned title generator contract on `engine/registry.ts`, and let the daemon auto-title pass coordinate fallback then AI replacement. Manual titles are protected by re-reading the live task title before every async write: fallback only writes over `(new task)`, and AI only writes over the exact fallback this pass produced. Claude gets a real generator through `claude -p --json-schema --no-session-persistence`; other engines may return `null` and keep fallback.

**Tech Stack:** TypeScript, Bun, Vitest, existing engine registry, existing daemon auto-title poller, existing task index store.

## Global Constraints

- No raw model SDK dependencies; use installed engine CLIs.
- Neutral layers must not hard-code Claude/Codex behavior; engine-specific title generation lives behind the engine registry.
- Manual task renames always win.
- Title generation must be best effort and must not crash the daemon.
- Tests must inject fake title generators and must not call real model APIs.
- Do not touch unrelated dirty files.

---

### Task 1: Preserve Existing Title Ownership Semantics

**Files:**
- Existing: `packages/kobe/src/orchestrator/core.ts`
- Existing: `packages/kobe/src/orchestrator/index/store.ts`
- Existing: `packages/kobe/test/orchestrator/branch-follow.test.ts`

**Interfaces:**
- Keep: `Orchestrator.setTitle(id, title)` as the only persisted title write.
- Keep: no new task-index field for title provenance.
- Keep: branch-follow only tracks the first non-placeholder title.

- [x] **Step 1: Confirm constraints**

Use the existing branch-follow tests as the invariant for branch behavior:

```ts
await orch.setTitle(task.id, "First name")
await orch.setTitle(task.id, "Second name")
expect(orch.getTask(task.id)?.branch).toBe(afterFirst)
```

Run: `cd packages/kobe && bunx vitest run test/orchestrator/branch-follow.test.ts`
Expected: PASS.

- [x] **Step 2: Keep the task index unchanged**

Do not add title provenance to `Task`. The daemon pass can protect user edits by comparing live titles at the async boundaries.

- [x] **Step 3: Verify**

Run: `cd packages/kobe && bunx vitest run test/orchestrator/branch-follow.test.ts`
Expected: PASS.

---

### Task 2: Extract Title Input And Fallback

**Files:**
- Modify: `packages/kobe/src/monitor/auto-title.ts`
- Test: `packages/kobe/test/monitor/auto-title.test.ts`

**Interfaces:**
- Produces: `TaskTitleInput { text: string; fallbackTitle: string }`.
- Produces: `deriveTitleInputFromSession(worktree, vendor): Promise<TaskTitleInput | null>`.
- Keeps: `deriveTitleFromSession()` and `deriveTitleFromSessionId()` as fallback-title compatibility wrappers.

- [x] **Step 1: Write failing tests**

Add tests proving:

```ts
const input = await deriveTitleInputFromSession(WORKTREE, "claude")
expect(input?.fallbackTitle).toBe("Fix login button.")
expect(input?.text).toContain("Fix login button")
expect(input?.text.length).toBeLessThanOrEqual(1000)
```

Include a long multi-message transcript where the returned `text` is tail-capped to 1000 characters.

Run: `cd packages/kobe && bunx vitest run test/monitor/auto-title.test.ts`
Expected: FAIL because `deriveTitleInputFromSession` does not exist.

- [x] **Step 2: Implement extraction**

Extract real user/assistant text from normalized messages, use the first user text for fallback, and tail-cap combined conversation text to 1000 characters.

- [x] **Step 3: Verify**

Run: `cd packages/kobe && bunx vitest run test/monitor/auto-title.test.ts`
Expected: PASS.

---

### Task 3: Add Engine Title Generator Contract

**Files:**
- Modify: `packages/kobe/src/engine/registry.ts`
- Create: `packages/kobe/src/engine/title-generator.ts`
- Create: `packages/kobe/src/engine/claude-code-local/title-generator.ts`
- Test: `packages/kobe/test/engine/title-generator.test.ts`

**Interfaces:**
- Produces: `EngineTitleGenerator.generateTitle(input, options?): Promise<string | null>`.
- Adds: `EngineRegistryEntry.titleGenerator`.
- Claude implementation builds a `claude -p` argv using `--output-format json`, `--json-schema`, `--no-session-persistence`, and the engine's small fast model.

- [x] **Step 1: Write failing tests**

Add tests for:

```ts
expect(parseGeneratedTitleJson('{"title":"Fix login button"}')).toBe("Fix login button")
expect(parseGeneratedTitleJson('{"result":"{\\"title\\":\\"Fix login button\\"}"}')).toBe("Fix login button")
expect(parseGeneratedTitleJson('{"title":""}')).toBeNull()
expect(buildClaudeTitleCommand("claude-haiku", "desc").argv).toContain("--no-session-persistence")
```

Run: `cd packages/kobe && bunx vitest run test/engine/title-generator.test.ts`
Expected: FAIL because the modules do not exist.

- [x] **Step 2: Implement parser and Claude generator**

Implement robust JSON parsing, single-line title cleanup, caps, injected spawn deps for tests, and default `null` generator for custom/unsupported engines.

- [x] **Step 3: Verify**

Run: `cd packages/kobe && bunx vitest run test/engine/title-generator.test.ts`
Expected: PASS.

---

### Task 4: Wire Daemon Auto-Title Two-Phase Update

**Files:**
- Modify: `packages/kobe-daemon/src/daemon/auto-title-poller.ts`
- Test: `packages/kobe/test/daemon/auto-title-poller.test.ts`
- Test: `packages/kobe/test/orchestrator/branch-follow.test.ts`

**Interfaces:**
- Changes: `runAutoTitlePass(orch, deriveInput?, generateTitle?)` returns renamed title events with source.
- Behavior: placeholder tasks get fallback first, then AI title if generation succeeds and the task is not manual.

- [x] **Step 1: Write failing tests**

Add tests proving:

```ts
const renamed = await runAutoTitlePass(orch, deriveInput, async () => "AI title")
expect(renamed.map((r) => r.source)).toEqual(["fallback", "ai"])
expect(orch.getTask(id)?.title).toBe("AI title")
```

Also test AI failure keeps fallback and manual rename during generation prevents AI overwrite.

Run: `cd packages/kobe && bunx vitest run test/daemon/auto-title-poller.test.ts test/orchestrator/branch-follow.test.ts`
Expected: FAIL because poller still accepts only a string deriver.

- [x] **Step 2: Implement poller wiring**

Use `deriveTitleInputFromSession` as the default input deriver and `engineEntry(vendor).titleGenerator.generateTitle()` as the default AI generator. Re-check the live task title before every write.

- [x] **Step 3: Verify**

Run: `cd packages/kobe && bunx vitest run test/daemon/auto-title-poller.test.ts test/orchestrator/branch-follow.test.ts`
Expected: PASS.

---

### Task 5: Final Verification

**Files:**
- All changed files.

- [x] **Step 1: Run targeted tests**

Run:

```bash
cd packages/kobe
bunx vitest run test/monitor/auto-title.test.ts test/engine/title-generator.test.ts test/orchestrator/branch-follow.test.ts
bun run test:socket -- test/daemon/auto-title-poller.test.ts
```

Expected: PASS.

- [x] **Step 2: Run project checks**

Run:

```bash
cd packages/kobe
bun run typecheck
bunx vitest run test/monitor/auto-title.test.ts test/engine/title-generator.test.ts test/orchestrator/branch-follow.test.ts
bun run test:socket -- test/daemon/auto-title-poller.test.ts
```

Expected: PASS.

- [x] **Step 3: Commit**

Stage only files changed for AI task titles and commit with:

```bash
git commit -m "feat: generate AI task titles"
```
