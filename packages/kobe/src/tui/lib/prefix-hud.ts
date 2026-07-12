/**
 * Keystroke HUD feed — a tiny framework-free stream the dispatch layer
 * writes and the workspace overlay renders (bottom-left of the Tasks
 * sidebar). Carries resolved PureTUI prefix sequences AND direct modifier
 * chords (`prefixKey: ""`). Keeps the last three plus the live armed flag;
 * entries carry a timestamp and the OVERLAY enforces expiry, so this module
 * owns no timers and stays inert for headless/unit-test dispatch.
 */

import { type ReadableState, createStateCell } from "../../lib/external-store"

/** How long a resolved line stays visible before the overlay flushes it. */
export const PREFIX_HUD_TTL_MS = 4000

const MAX_ENTRIES = 3

export type PrefixHudEntry = {
  id: number
  /** First stroke as displayed, e.g. `ctrl+a`. */
  prefixKey: string
  /** Second stroke as displayed, e.g. `t`. */
  stroke: string
  /** Resolved binding id (`tab.new`) — null when nothing was bound. */
  action: string | null
  at: number
}

export type PrefixHudSnapshot = {
  /** True while the prefix is armed and waiting on the second stroke. */
  armed: boolean
  entries: readonly PrefixHudEntry[]
}

const cell = createStateCell<PrefixHudSnapshot>({ armed: false, entries: [] })
let nextEntryId = 1

export const prefixHudState: ReadableState<PrefixHudSnapshot> = cell

export function prefixHudSetArmed(armed: boolean): void {
  cell.update((current) => (current.armed === armed ? current : { ...current, armed }))
}

export function prefixHudPush(entry: Omit<PrefixHudEntry, "id">): void {
  cell.update((current) => ({
    armed: false,
    entries: [...current.entries, { ...entry, id: nextEntryId++ }].slice(-MAX_ENTRIES),
  }))
}

/** Test seam — clears the feed between unit tests. */
export function resetPrefixHud(): void {
  cell.set({ armed: false, entries: [] })
}
