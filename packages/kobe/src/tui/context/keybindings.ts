/**
 * Keymap RUNTIME — lookup index, chord resolution, override reset, and the
 * reload version store. The chord-table DATA (`KobeKeymap` + the row types
 * and the full hand-off contract doc) lives in `keybindings-table.ts` and
 * is re-exported here so every existing importer (panes, help dialog,
 * tests, the `src/tui-react/context/keybindings.ts` shim) keeps compiling
 * unchanged.
 */

import type { Binding } from "../lib/keymap-dispatch.ts"
import type { KobeBinding, KobeBindingHint } from "./keybindings-table.ts"
import { KobeKeymap } from "./keybindings-table.ts"

export { KobeKeymap } from "./keybindings-table.ts"
export type { KobeBinding, KobeBindingHint, KobeBindingScope } from "./keybindings-table.ts"

/**
 * Pristine snapshot of every row's overridable fields (`keys` + `hint`),
 * captured at module load BEFORE any `applyKeymapOverrides` mutation. The
 * live-reload path ({@link resetKeymapToDefaults}) restores from this so a
 * removed override returns to its default — additive in-place mutation
 * alone can't "un-override" a row.
 */
const KEYMAP_DEFAULTS: ReadonlyMap<string, { keys: readonly string[]; hint?: KobeBindingHint }> = new Map(
  KobeKeymap.map((b) => [b.id, { keys: [...b.keys], hint: b.hint ? { ...b.hint } : undefined }]),
)

/**
 * Default chords for a binding id, read from the pristine
 * {@link KEYMAP_DEFAULTS} snapshot — NOT the live (possibly
 * user-overridden) row. `RESERVED_GLOBAL_CHORDS`
 * (panes/terminal/keys-pure.ts) derives the terminal-passthrough
 * reservation from this, so a user override never changes which chords
 * the embedded terminal swallows. Unknown id → empty array (same
 * contract as {@link chordsOf}).
 */
export function defaultChordsOf(id: string): readonly string[] {
  return KEYMAP_DEFAULTS.get(id)?.keys ?? []
}

/**
 * Restore every `KobeKeymap` row to its boot-time default chords + hint.
 * Called before re-applying the (re-read) keybindings file on a live
 * reload, so the net effect is "defaults + current overrides", never a
 * pile-up of stale overrides. Mutates in place — the same cast
 * `applyKeymapOverrides` uses, since the rows are runtime-mutable despite
 * the `readonly` types.
 */
export function resetKeymapToDefaults(): void {
  for (const row of KobeKeymap) {
    const def = KEYMAP_DEFAULTS.get(row.id)
    if (!def) continue
    const mutable = row as { keys: readonly string[]; hint?: KobeBindingHint }
    mutable.keys = [...def.keys]
    mutable.hint = def.hint ? { ...def.hint } : undefined
  }
}

/**
 * A bump-only version token: every live keymap reload increments it. The
 * chord LEGENDS (status bar, help dialog) read it so they re-render after a
 * reload — the keymap array is mutated in place, so a mutation is otherwise
 * invisible to the renderer. Behaviour doesn't need it (the dispatcher
 * re-reads chords on every keypress); this is purely the display nudge.
 *
 * React consumers subscribe via `useSyncExternalStore(subscribeKeymapVersion,
 * keymapVersion)` (src/tui-react/context/keybindings.ts) — `keymapVersion()`
 * is the getSnapshot getter, `subscribeKeymapVersion` the store subscription.
 */
let keymapVersionValue = 0
const keymapVersionListeners = new Set<() => void>()

/** Current keymap version (getSnapshot for `useSyncExternalStore`). */
export function keymapVersion(): number {
  return keymapVersionValue
}

/** Subscribe to keymap reloads. Returns the unsubscribe fn. */
export function subscribeKeymapVersion(listener: () => void): () => void {
  keymapVersionListeners.add(listener)
  return () => {
    keymapVersionListeners.delete(listener)
  }
}

/** Increment {@link keymapVersion}, forcing chord legends to re-render. */
export function bumpKeymapVersion(): void {
  keymapVersionValue += 1
  for (const listener of [...keymapVersionListeners]) listener()
}

/**
 * id → row index. Safe to build once: `KobeKeymap` rows are mutated in
 * place by overrides (`keys` / `hint` fields change) but never added,
 * removed, or replaced, so the row identities the map holds stay
 * canonical forever. This keeps `findBinding` O(1) — it runs per id per
 * registered binding group on EVERY keypress (`useBindings` configs call
 * `bindByIds` on each dispatch), where the previous linear scan cost
 * ~60 row comparisons per id (~1.4k per keypress at a realistic
 * 5-group / 23-id stack).
 */
const KEYMAP_BY_ID: ReadonlyMap<string, KobeBinding> = new Map(KobeKeymap.map((b) => [b.id, b]))

/** Lookup helper used by tests and pane registration. */
export function findBinding(id: string): KobeBinding | undefined {
  return KEYMAP_BY_ID.get(id)
}

/**
 * Resolve the chord list for a binding id. Returns an empty array if the
 * id isn't found — `bindByIds` warns but doesn't throw, so a typo doesn't
 * crash the renderer.
 */
export function chordsOf(id: string): readonly string[] {
  return findBinding(id)?.keys ?? []
}

/**
 * Build a list of `Binding` (chord → handler) entries from a map of
 * `binding-id → handler`. Each id's chords from `KobeKeymap` get
 * registered against the same handler. Pane code uses this so it doesn't
 * have to know the chord strings — those live in `KobeKeymap`.
 *
 * Each entry carries `slot` = the chord's index within the id's (possibly
 * user-overridden) `keys` array, and the dispatcher passes it to the
 * handler as a second argument. Multiplexed handlers (`sidebar.nav`,
 * `files.hierarchy`, …) decide direction from the slot instead of
 * `evt.name`, which is what lets users rebind those ids: the slot LAYOUT
 * is the per-id positional contract (`SLOT_CONTRACTS` in
 * keymap-overrides.ts validates override counts against it). Because the
 * `useBindings` config closure re-runs `bindByIds` on every keypress,
 * slots are always derived from the CURRENT keymap — a live keybindings
 * reload re-slots automatically.
 *
 * Unknown ids log a warning and are skipped (typos shouldn't crash the
 * UI, but they should be loud in dev).
 */
export function bindByIds(handlers: Record<string, Binding["cmd"]>): Binding[] {
  const out: Binding[] = []
  for (const id in handlers) {
    const cmd = handlers[id]
    if (!cmd) continue
    const chords = chordsOf(id)
    if (chords.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[kobe/keybindings] bindByIds: id="${id}" has no chords (or doesn't exist in KobeKeymap)`)
      continue
    }
    chords.forEach((c, slot) => out.push({ key: c, cmd, slot }))
  }
  return out
}
