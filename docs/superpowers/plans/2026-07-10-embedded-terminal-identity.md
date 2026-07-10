# Embedded Terminal Identity Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Kobe's embedded terminals from advertising the outer terminal emulator's identity to child applications.

**Architecture:** Add one package-level pure environment builder in `@sma1lboy/kobe-daemon` that removes `TERM_PROGRAM` and `TERM_PROGRAM_VERSION` while preserving all capability variables and explicit PTY overrides. Reuse it from the daemon-hosted PTY, Bun PTY, pipe fallback, and web PTY sidecar; keep the web sidecar's existing `NO_COLOR`/`CLICOLOR` policy in a small wrapper.

**Tech Stack:** TypeScript, ESM JavaScript, Bun PTY, node-pty, Vitest, bun:test.

## Global Constraints

- Do not modify user Neovim, shell, or global terminal configuration.
- Remove only `TERM_PROGRAM` and `TERM_PROGRAM_VERSION`; retain `TERM`, `COLORTERM`, and Kobe's PTY marker variables.
- Apply the policy at every embedded PTY spawn boundary: hosted, Bun fallback, pipe fallback, and web.
- Preserve the in-progress terminal-palette work already present in the working tree.
- Add no dependency and keep every touched source file below 500 lines.
- Add one patch changeset; do not promote the release bump.
- Restart the daemon after daemon code changes.

---

### Task 1: Shared environment policy

**Files:**
- Create: `packages/kobe-daemon/src/daemon/pty-env.js`
- Create: `packages/kobe-daemon/src/daemon/pty-env.d.ts`
- Modify: `packages/kobe-daemon/package.json`
- Create: `packages/kobe/test/lib/embedded-terminal-env.test.ts`

**Interfaces:**
- Produces: `embeddedTerminalEnv(base, overrides?) -> NodeJS.ProcessEnv` from `@sma1lboy/kobe-daemon/daemon/pty-env`.
- Guarantees: the returned object omits `TERM_PROGRAM` and `TERM_PROGRAM_VERSION`, does not mutate `base`, and applies explicit overrides last.

- [x] **Step 1: Add a compiling stub and the failing pure test**

Create the package export and a stub that clones the environment without removing terminal identity. Add this test:

```ts
import { describe, expect, it } from "vitest"
import { embeddedTerminalEnv } from "@sma1lboy/kobe-daemon/daemon/pty-env"

describe("embeddedTerminalEnv", () => {
  it("removes the outer terminal identity while retaining capabilities and overrides", () => {
    const base = {
      TERM_PROGRAM: "iTerm.app",
      TERM_PROGRAM_VERSION: "3.6.11",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      HOME: "/home/test",
    }
    const result = embeddedTerminalEnv(base, { KOBE_TERMINAL_PTY: "1" })
    expect(result).toEqual({
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      HOME: "/home/test",
      KOBE_TERMINAL_PTY: "1",
    })
    expect(base.TERM_PROGRAM).toBe("iTerm.app")
  })
})
```

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
cd packages/kobe
bunx vitest run test/lib/embedded-terminal-env.test.ts
```

Expected: FAIL because the stub still returns `TERM_PROGRAM` and `TERM_PROGRAM_VERSION`.

- [x] **Step 3: Implement the minimal environment builder**

Replace the stub with:

```js
export function embeddedTerminalEnv(base, overrides = {}) {
  const { TERM_PROGRAM: _termProgram, TERM_PROGRAM_VERSION: _termProgramVersion, ...env } = base
  return { ...env, ...overrides }
}
```

- [x] **Step 4: Run the pure test and verify GREEN**

Run the same focused Vitest command. Expected: PASS.

---

### Task 2: Hosted, Bun, and pipe PTY spawn boundaries

**Files:**
- Modify: `packages/kobe-daemon/src/daemon/pty-host.ts`
- Modify: `packages/kobe/src/tui/panes/terminal/pty.ts`
- Modify: `packages/kobe/src/tui/panes/terminal/pty-pipe.ts`
- Modify: `packages/kobe/test/render/pty-host.test.ts`
- Create: `packages/kobe/test/render/pty-local-env.test.ts`

**Interfaces:**
- Consumes: `embeddedTerminalEnv` from Task 1.
- Preserves: each backend's existing `TERM`, geometry, shell-warning, and Kobe marker overrides.

- [x] **Step 1: Add failing real-child environment tests**

For `PtyHost`, spawn `/bin/sh -c` to print `${TERM_PROGRAM-unset}` and `${TERM_PROGRAM_VERSION-unset}` while the parent environment contains iTerm values. For `BunTerminalTaskPty` and `PipeTaskPty`, do the same and poll their existing `capture()` surfaces. Each assertion expects `program=unset version=unset`.

- [x] **Step 2: Run render tests and verify RED**

Run:

```bash
cd packages/kobe
bun test test/render/pty-host.test.ts test/render/pty-local-env.test.ts
```

Expected: the three new assertions fail with inherited `iTerm.app` / `3.6.11` values.

- [x] **Step 3: Route all three spawn environments through the shared helper**

Replace each inline `{ ...process.env, ...overrides }` with:

```ts
embeddedTerminalEnv(process.env, {
  TERM: "xterm-256color",
  COLUMNS: String(this.cols),
  LINES: String(this.rows),
  BASH_SILENCE_DEPRECATION_WARNING: "1",
  KOBE_TERMINAL_PTY: "1",
})
```

The daemon-hosted and Bun blocks use the four overrides above. The pipe block
uses `TERM: process.env.TERM ?? "xterm-256color"`, its current `COLUMNS` and
`LINES`, and `KOBE_TERMINAL_PIPE: "1"`.

- [x] **Step 4: Run render tests and verify GREEN**

Run the same focused Bun test command. Expected: all selected tests pass.

---

### Task 3: Web PTY sidecar

**Files:**
- Create: `packages/kobe-web/pty-env.mjs`
- Modify: `packages/kobe-web/pty-server.mjs`
- Create: `packages/kobe-web/test/pty-env.test.ts`

**Interfaces:**
- Produces: `ptyEnv(base?)`, which composes the shared identity cleanup with the web sidecar's existing `NO_COLOR`, `CLICOLOR`, and `COLORTERM` policy.

- [x] **Step 1: Extract the existing web policy and add a failing identity test**

Create `pty-env.mjs` with the current `NO_COLOR` behavior but without identity cleanup. Add a test whose explicit base contains iTerm identity and `NO_COLOR=1`; expect identity and `NO_COLOR` absent, with `CLICOLOR=1` and `COLORTERM=truecolor` retained.

- [x] **Step 2: Run the web test and verify RED**

Run:

```bash
cd packages/kobe-web
bunx vitest run test/pty-env.test.ts
```

Expected: FAIL because the extracted current behavior still retains the two iTerm variables.

- [x] **Step 3: Compose the shared helper and wire the server**

Import `embeddedTerminalEnv`, call it after removing `NO_COLOR`, export `ptyEnv`, and replace the server-local function with an import from `./pty-env.mjs`.

- [x] **Step 4: Run the web test and verify GREEN**

Run the same focused Vitest command. Expected: PASS.

---

### Task 4: Release note and verification

**Files:**
- Create: `.changeset/embedded-terminal-identity.md`
- Modify: only files listed in Tasks 1-3 and this plan.

- [x] **Step 1: Add a patch changeset**

```md
---
"@sma1lboy/kobe": patch
---

Embedded terminals no longer leak the outer emulator's identity to child applications, preventing terminal-specific escape sequences from being selected for the wrong parser.
```

- [x] **Step 2: Run focused and package verification**

```bash
cd packages/kobe && bun test test/render/pty-host.test.ts test/render/pty-local-env.test.ts
cd packages/kobe && bunx vitest run test/lib/embedded-terminal-env.test.ts
bun --filter @sma1lboy/kobe typecheck
bun --filter @sma1lboy/kobe-daemon typecheck
cd packages/kobe-web && bunx vitest run test/pty-env.test.ts
bun --filter kobe-web build
```

Expected: every command exits 0 without new warnings.

- [x] **Step 3: Run hygiene checks and restart the daemon**

```bash
git diff --check
bunx biome check packages/kobe-daemon/src/daemon/pty-env.js packages/kobe-daemon/src/daemon/pty-env.d.ts packages/kobe-daemon/src/daemon/pty-host.ts packages/kobe/src/tui/panes/terminal/pty.ts packages/kobe/src/tui/panes/terminal/pty-pipe.ts packages/kobe-web/pty-env.mjs packages/kobe-web/pty-server.mjs packages/kobe/test/lib/embedded-terminal-env.test.ts packages/kobe/test/render/pty-host.test.ts packages/kobe/test/render/pty-local-env.test.ts packages/kobe-web/test/pty-env.test.ts
kobe daemon restart
```

- [x] **Step 4: Commit only this stream's hunks**

Inspect `git status`, `git diff`, and `git diff --cached`. Stage only the files and partial `pty-pipe.ts` hunks belonging to terminal identity isolation, then commit with a conventional message and 2-3 sentence body. Do not stage the pre-existing palette implementation or unrelated workspace files.
