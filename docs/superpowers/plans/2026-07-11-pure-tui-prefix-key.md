# PureTUI Prefix Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move PureTUI control-chord actions into a configurable prefix sequence while retaining Binding Stack scope and modal rules.

**Architecture:** The framework-free dispatcher records one armed prefix and matches the next event exclusively against prefix-marked bindings. `KobeKeymap` stores direct and prefix second strokes separately; the user settings loader applies prefix settings and second-stroke overrides without involving the tmux resolver.

**Tech Stack:** TypeScript, Bun, Vitest, @opentui/core key events, React registration through `useBindings`.

## Global Constraints

- Apply only to the Workspace Host (`KOBE_TUI=1`) Binding Stack; do not change tmux Handover behavior.
- Preserve modal-barrier, `enabled` gate, LIFO, slot, and Terminal pane raw-input contracts.
- Use domain terms `Workspace Host`, `Binding Stack`, `Terminal Tab`, and `Terminal pane`.
- Keep touched source files at or under about 500 lines.

---

### Task 1: Prefix dispatcher core

**Files:**
- Modify: `packages/kobe/src/tui/lib/keymap-dispatch.ts`
- Test: `packages/kobe/test/tui/keymap-prefix.test.ts`

**Interfaces:**
- Produces: prefix-marked `Binding` entries and configurable, resettable dispatcher prefix state.

- [ ] Write failing tests for prefix entry, scoped second-stroke dispatch, timeout, cancellation, and modal isolation.
- [ ] Run `cd packages/kobe && bunx vitest run test/tui/keymap-prefix.test.ts` and confirm the missing prefix API fails.
- [ ] Add the smallest framework-free prefix state and dispatch branch that makes the tests pass.
- [ ] Re-run the focused test and `test/tui/keymap-dispatch.test.ts`.

### Task 2: Keymap catalogue and user configuration

**Files:**
- Modify: `packages/kobe/src/tui/context/keybindings.ts`
- Modify: `packages/kobe/src/tui/context/keybindings-user.ts`
- Create: `packages/kobe/src/tui/lib/keymap-prefix-overrides.ts`
- Test: `packages/kobe/test/tui/keymap-prefix-overrides.test.ts`

**Interfaces:**
- Consumes: prefix-marked `Binding` support from Task 1.
- Produces: `prefix.key`, `prefix.timeoutMs`, and `prefix.bindings` YAML support.

- [ ] Write failing parsing and override tests, including platform overlay and invalid bare prefix rejection.
- [ ] Run the focused test and confirm the new module/API is absent.
- [ ] Store prefix second strokes separately from direct keys, migrate PureTUI control rows, and apply/reset settings on live reload.
- [ ] Re-run focused configuration and keymap slot/reload tests.

### Task 3: User-facing keybinding record and regression verification

**Files:**
- Modify: `docs/KEYBINDINGS.md`
- Test: `packages/kobe/test/tui/keymap-prefix.test.ts`

**Interfaces:**
- Consumes: final dispatcher and YAML behaviour from Tasks 1–2.

- [ ] Update the canonical keybinding record with the prefix contract and YAML examples.
- [ ] Run focused tests, then package typecheck and the relevant keymap suite.
- [ ] Inspect `git diff` and commit only this feature's files once checks pass.
