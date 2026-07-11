/** Runtime binding expansion for the canonical KobeKeymap catalogue. */

import type { Binding } from "../lib/keymap-dispatch"
import { findBinding } from "./keybindings"

/** Resolve direct chords for one binding id. */
export function chordsOf(id: string): readonly string[] {
  return findBinding(id)?.keys ?? []
}

/** Resolve configured-prefix second strokes for one binding id. */
export function prefixChordsOf(id: string): readonly string[] {
  return findBinding(id)?.prefixKeys ?? []
}

/** Expand binding ids into direct and prefix-marked dispatcher entries. */
export function bindByIds(handlers: Record<string, Binding["cmd"]>): Binding[] {
  const out: Binding[] = []
  for (const id in handlers) {
    const cmd = handlers[id]
    if (!cmd) continue
    const binding = findBinding(id)
    const chords = binding?.keys ?? []
    const prefixChords = binding?.prefixKeys ?? []
    if (chords.length === 0 && prefixChords.length === 0) {
      console.warn(`[kobe/keybindings] bindByIds: id="${id}" has no chords (or doesn't exist in KobeKeymap)`)
      continue
    }
    chords.forEach((key, slot) => out.push({ key, cmd, slot }))
    const prefixSlotOffset = binding?.prefixSlotOffset ?? chords.length
    prefixChords.forEach((key, index) => out.push({ key, prefix: true, cmd, slot: prefixSlotOffset + index }))
  }
  return out
}
