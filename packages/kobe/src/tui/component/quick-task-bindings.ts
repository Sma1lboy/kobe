/**
 * Pure binding builder for the quick-task composer — extracted from
 * `quick-task-composer.tsx` so the field-gating contract is
 * vitest-testable (the component file drags in `@opentui`).
 *
 * THE contract (regression: "type a prompt, hit enter" was dead): a
 * matched binding consumes its keypress — `dispatchKeyEvent` calls
 * `preventDefault()` on every hit, so the focused input never sees the
 * key. Field-dependent chords therefore must be gated at REGISTRATION:
 * `return` / `left` / `right` exist in the returned list ONLY while the
 * engine chip row is focused. On the prompt/branch fields they're
 * absent, so Enter falls through to the input's own `onSubmit` (commit)
 * and ←/→ move the input cursor.
 */

import type { Binding } from "../lib/keymap-dispatch"

export type QuickTaskField = "prompt" | "engine" | "branch"

export interface QuickTaskBindingHandlers {
  cycleField: (dir: 1 | -1) => void
  stepEngine: (dir: 1 | -1) => void
  commit: () => void
}

export function quickTaskBindings(field: QuickTaskField, h: QuickTaskBindingHandlers): Binding[] {
  return [
    { key: "tab", cmd: () => h.cycleField(1) },
    { key: "shift+tab", cmd: () => h.cycleField(-1) },
    { key: "ctrl+e", cmd: () => h.stepEngine(1) },
    ...(field === "engine"
      ? [
          // ←/→ cycle the engine; enter commits (a chip row has no input
          // to fire onSubmit — the text fields commit via theirs).
          { key: "left", cmd: () => h.stepEngine(-1) },
          { key: "right", cmd: () => h.stepEngine(1) },
          { key: "return", cmd: () => h.commit() },
        ]
      : []),
  ]
}
