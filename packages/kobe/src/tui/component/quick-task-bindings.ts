import type { Binding } from "../lib/keymap-dispatch"

export type QuickTaskField = "prompt" | "engine" | "branch"

export interface QuickTaskBindingHandlers {
  cycleField: (dir: 1 | -1) => void
  stepEngine: (dir: 1 | -1) => void
  commit: () => void
  pasteAttachment: () => void
  removeLastAttachment: () => void
}

export function quickTaskBindings(field: QuickTaskField, h: QuickTaskBindingHandlers): Binding[] {
  return [
    { key: "tab", cmd: () => h.cycleField(1) },
    { key: "shift+tab", cmd: () => h.cycleField(-1) },
    { key: "ctrl+e", cmd: () => h.stepEngine(1) },
    { key: "ctrl+v", cmd: () => h.pasteAttachment() },
    { key: "ctrl+x", cmd: () => h.removeLastAttachment() },
    ...(field === "engine"
      ? [
          { key: "left", cmd: () => h.stepEngine(-1) },
          { key: "right", cmd: () => h.stepEngine(1) },
          { key: "return", cmd: () => h.commit() },
        ]
      : []),
  ]
}
