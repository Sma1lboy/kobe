/**
 * Apply policy for user keybinding overrides (~/.kobe/settings/keybindings.yaml).
 *
 * Split out of the loader (`src/tui/context/keybindings-user.ts`) for the
 * same reason `keymap-dispatch.ts` is split out of `keymap.tsx`: vitest
 * can't import `@opentui/*` (transitive `.scm` assets), so everything
 * testable — validation and the keymap mutation — lives here with zero
 * opentui imports. The loader is a thin Bun-runtime wrapper (read file →
 * `Bun.YAML.parse` → these functions).
 *
 * The parsing half — chord grammar, config shape, YAML-document
 * extraction — lives in `keymap-overrides-parse.ts` and is re-exported
 * below, so consumers keep importing everything from this module.
 */

import type { KeymapOverrideEntry } from "./keymap-overrides-parse"

export {
  type ChordResult,
  type ExtractOverridesOpts,
  type KeymapOverrideEntry,
  type NormalizeChordOpts,
  extractKeybindingOverrides,
  normalizeChord,
} from "./keymap-overrides-parse"

export type OverridableHint = {
  keys: string
}

/**
 * Structural slice of `KobeBinding` this module needs. `KobeBinding` is
 * assignable; keeping a local type avoids importing the opentui-tainted
 * keybindings module.
 */
export type OverridableBinding = {
  id: string
  scope: string
  keys: readonly string[]
  hint?: OverridableHint
}

/** One override that actually landed on the keymap. */
export type AppliedOverride = {
  id: string
  keys: readonly string[]
  defaultKeys: readonly string[]
}

/**
 * Ids that genuinely cannot be rebound. Two families:
 *
 *   - `evt.shift`-gated handlers: the chord registered is a bare letter
 *     and the handler fires only on the SHIFTED press (`Shift+G/P/M`).
 *     The chord grammar can't express `shift+<letter>` (terminals deliver
 *     it as a plain uppercase character — see `normalizeChord`), so a
 *     rebind could never carry the shift half. Fixed until/unless the
 *     handlers drop the shift gate.
 *   - positional sets mirrored OUTSIDE this keymap, or rows with no live
 *     registration site (rebinding would change the F1/help display
 *     without changing behavior — worse than refusing).
 *
 * Direction-multiplexed ids (`sidebar.nav`, `files.hierarchy`, …) are NOT
 * fixed anymore — their handlers dispatch on the matched chord's SLOT
 * (see {@link SLOT_CONTRACTS}), not on `evt.name`.
 *
 * Value = the reason shown in warnings / settings.
 */
export const FIXED_BINDING_IDS: Readonly<Record<string, string>> = {
  "focus.numeric":
    "pane focus is positional (h/j/k/l → pane) and mirrors the tmux-layer ctrl+hjkl bindings — rebind tmux.focus instead",
  "sidebar.goto":
    "gg vs Shift+G is discriminated via evt.shift; shift+<letter> chords are inexpressible, so a rebind can't carry both halves",
  "sidebar.pin": "fires on Shift+P via evt.shift; shift+<letter> chords are inexpressible, so a rebind can't work",
  "sidebar.localMerge":
    "fires on Shift+M via evt.shift; shift+<letter> chords are inexpressible, so a rebind can't work",
  "chat.question.nav":
    "the question picker has no live registration site (display-only row) — rebinding would change Help without changing behavior",
  "chat.question.pick-number":
    "digits map to options positionally and the question picker has no live registration site (display-only row)",
}

/**
 * Positional slot contract for a direction-multiplexed binding id. The
 * keymap layer threads the matched chord's index within the id's `keys`
 * array to the handler (`Binding.slot`, assigned by `bindByIds`), so the
 * MEANING of each position — the slot layout — is a documented contract
 * an override must respect. `tmux.focus` (exactly 4 chords, order
 * left/down/up/right, validated in `src/tmux/keybindings.ts`) is the
 * precedent.
 */
export type SlotContract = {
  /** Human-readable layout, used in warnings and the docs. */
  layout: string
  /** Null when `count` chords satisfy the layout; otherwise the problem. */
  validateCount: (count: number) => string | null
}

/** Alternating pairs: even slots → `first`, odd slots → `second`. */
function pairContract(first: string, second: string): SlotContract {
  const layout = `alternating [${first}, ${second}] pairs`
  return {
    layout,
    validateCount: (count) =>
      count >= 2 && count % 2 === 0 ? null : `needs ${layout} (an even number of chords — got ${count})`,
  }
}

/**
 * Slot layouts for the user-rebindable multiplexed ids. Handlers map
 * `slot % 2` (pairs), so any even chord count works: the 4-chord default
 * `sidebar.nav: [j, k, down, up]` and a 2-chord override
 * `sidebar.nav: [w, s]` follow the same contract. Validation runs in
 * {@link applyKeymapOverrides} (and re-runs on a live keybindings
 * reload, since the reload path resets and re-applies from scratch).
 */
export const SLOT_CONTRACTS: Readonly<Record<string, SlotContract>> = {
  "sidebar.nav": pairContract("down", "up"),
  "files.nav": pairContract("down", "up"),
  "sidebar.search.nav": pairContract("down", "up"),
  "files.hierarchy": pairContract("collapse", "expand"),
  "sidebar.view": pairContract("previous view", "next view"),
  "files.tab": pairContract("previous tab", "next tab"),
  // Not a pair: slot 0 = quit confirm, slot 1 = hard exit (native
  // workspace's second ctrl+q). The hard-exit chord is optional — a
  // single-chord override keeps the confirm and drops the two-stage exit.
  "app.quit": {
    layout: "[quit confirm, hard exit] (second chord optional)",
    validateCount: (count) => (count <= 2 ? null : `needs [quit confirm, hard exit] (1 or 2 chords — got ${count})`),
  },
}

/** Scopes where a bare single-character chord would steal typed input. */
const NO_BARE_LETTER_SCOPES = new Set(["global", "workspace", "terminal"])

/** True when two binding scopes can both be live for the same keypress. */
function scopesOverlap(a: string, b: string): boolean {
  return a === b || a === "global" || b === "global"
}

/**
 * Validate the requested overrides against `keymap` and apply the
 * survivors by MUTATING the matching rows in place (`keys`, plus a
 * refreshed `hint.keys` so the help dialog / footer legend advertise the
 * user's chord, not the stale default). Returns what landed and every
 * warning produced on the way.
 */
export function applyKeymapOverrides(
  keymap: readonly OverridableBinding[],
  entries: readonly KeymapOverrideEntry[],
): { applied: AppliedOverride[]; warnings: string[] } {
  const warnings: string[] = []
  const applied: AppliedOverride[] = []

  for (const entry of entries) {
    const row = keymap.find((b) => b.id === entry.id)
    if (!row) {
      warnings.push(`${entry.id}: unknown binding id (press F1 in kobe for the full list)`)
      continue
    }
    const fixedReason = FIXED_BINDING_IDS[entry.id]
    if (fixedReason) {
      warnings.push(`${entry.id}: not customizable — ${fixedReason}`)
      continue
    }
    if (row.keys.length === 0) {
      warnings.push(`${entry.id}: not customizable — the key is handled outside the keymap (doc-only row)`)
      continue
    }

    // Slot-contract count check (direction-multiplexed ids): the handler
    // maps slot position → action, so an override must supply a chord
    // count matching the documented layout. Unbind ([]) is exempt — an
    // empty list disables the id wholesale, no slots involved.
    const contract = SLOT_CONTRACTS[entry.id]
    if (contract && entry.keys.length > 0) {
      const problem = contract.validateCount(entry.keys.length)
      if (problem) {
        warnings.push(`${entry.id}: ${problem} — keeping the default`)
        continue
      }
    }

    // Boundary rule (docs/KEYBINDINGS.md): a bare single character on a
    // scope whose focused surface accepts typed text would steal input.
    const keys = entry.keys.filter((chord) => {
      if (chord.length === 1 && NO_BARE_LETTER_SCOPES.has(row.scope)) {
        warnings.push(
          `${entry.id}: "${chord}" dropped — a bare character on a ${row.scope}-scope binding would steal typed input (add a modifier)`,
        )
        return false
      }
      return true
    })
    if (keys.length === 0 && entry.keys.length > 0) {
      warnings.push(`${entry.id}: no chords survived validation — keeping the default`)
      continue
    }
    // A slot id can't survive a partial drop: removing one chord shifts
    // every later slot, silently remapping directions. All-or-nothing.
    if (contract && keys.length !== entry.keys.length) {
      warnings.push(
        `${entry.id}: a dropped chord would shift the slot layout (${contract.layout}) — keeping the default`,
      )
      continue
    }

    const defaultKeys = row.keys
    const mutable = row as { keys: readonly string[]; hint?: OverridableHint }
    mutable.keys = keys
    if (row.hint) {
      if (keys.length === 0) {
        // Unbound — a hint advertising a dead chord is worse than none.
        mutable.hint = undefined
      } else {
        row.hint.keys = keys.join("/")
      }
    }
    applied.push({ id: entry.id, keys, defaultKeys })
  }

  // Conflict scan — only for chords an override introduced (pre-existing
  // same-chord pairs like sidebar.select / sidebar.search.submit are
  // intentional, gated by mode at the registration site).
  for (const change of applied) {
    for (const chord of change.keys) {
      const owner = keymap.find((b) => b.id === change.id)
      if (!owner) continue
      for (const other of keymap) {
        if (other.id === change.id) continue
        if (!other.keys.includes(chord)) continue
        if (!scopesOverlap(owner.scope, other.scope)) continue
        warnings.push(
          `${change.id}: "${chord}" also fires ${other.id} (${other.scope} scope) — last registration wins; consider a different chord`,
        )
      }
    }
  }

  return { applied, warnings }
}
