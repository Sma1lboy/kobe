/**
 * User-customizable tmux-layer session keys (`tmux.*` ids in
 * `~/.kobe/settings/keybindings.yaml`).
 *
 * The direct-tmux handover chords (ctrl+t / ctrl+[ / ctrl+] / ctrl+w /
 * ctrl+q / ctrl+hjkl, F2, and prefix-scoped layout keys) are NOT opentui bindings — they're real tmux
 * server bindings installed by `ensureSession` on the `-L kobe` socket
 * (`src/tui/panes/terminal/tmux.ts`). This module gives them the same
 * YAML override path as `KobeKeymap` ids, sharing the file reader
 * (`src/state/keybindings-file.ts`) and the pure chord grammar
 * (`src/tui/lib/keymap-overrides.ts`) so one config file drives both
 * layers. No `@opentui/*` imports — tmux.ts is vitest-imported.
 *
 * Ids and override shapes:
 *
 * ```yaml
 * bindings:
 *   tmux.tab.new: ctrl+y            # one chord per id…
 *   tmux.tab.close: null            # …null = don't install the binding
 *   tmux.focus: [ctrl+left, ctrl+down, ctrl+up, ctrl+right]
 *   #            ^ POSITIONAL group: exactly 4 chords, order left/down/up/right
 *   tmux.tab.chooseEngine: ctrl+shift+e   # shift+letter OK here (tmux C-S-…)
 * ```
 *
 * Validation beyond the shared chord grammar:
 *   - `cmd+` chords are rejected — the macOS Command key never reaches tmux.
 *   - bare keys (no modifier) are rejected unless they're F-keys for
 *     no-prefix ROOT-table bindings because they live in every pane and would
 *     shadow typed input. Prefix-table bindings may use bare keys.
 *   - tmux can't express every named key; unsupported names are rejected.
 *
 * Stale-bind hygiene: tmux servers are long-lived, so when an id is
 * overridden the INSTALLER must also `unbind-key -n <default>` — handled
 * by `ensureSession` using `overridden` from the resolution (verified:
 * unbinding a never-bound root key exits 0 silently).
 */

import { readKeybindingsFile } from "../state/keybindings-file"
import { type KeymapOverrideEntry, extractKeybindingOverrides, normalizeChord } from "../tui/lib/keymap-overrides"

/** No-prefix single-chord tmux binding ids. `tmux.focus` (the 4-chord group) is separate. */
export const TMUX_ROOT_BINDING_DEFAULTS = {
  /** Two-stage: focus the Tasks pane, then detach on a second press from there. */
  "tmux.detach": "ctrl+q",
  /** New same-engine ChatTab window. */
  "tmux.tab.new": "ctrl+t",
  /** Prompt for an engine, then open a ChatTab (terminal must forward the chord). */
  "tmux.tab.chooseEngine": "ctrl+shift+t",
  /** Previous ChatTab window. */
  "tmux.tab.prev": "ctrl+[",
  /** Next ChatTab window. */
  "tmux.tab.next": "ctrl+]",
  /** Close the current ChatTab window (final window protected). */
  "tmux.tab.close": "ctrl+w",
  /** Rename the current ChatTab window. */
  "tmux.tab.rename": "f2",
} as const

/** Prefix-table layout bindings. These do not steal input from engine/shell panes. */
export const TMUX_PREFIX_BINDING_DEFAULTS = {
  /** Add a temporary shell split in the middle workspace area (max 4 panes). */
  "tmux.layout.workspaceSplit": "s",
  /** Close the focused workspace split, or the most recent split. */
  "tmux.layout.workspaceClose": "x",
  /** Close all temporary workspace splits in the current ChatTab. */
  "tmux.layout.workspaceReset": "r",
  /** Hide/restore the Tasks rail while preserving its pane process. */
  "tmux.layout.tasksToggle": "a",
  /** Toggle the file/Ops pane in the current ChatTab. */
  "tmux.layout.opsToggle": "o",
  /** Hide/restore the terminal pane while preserving its shell process. */
  "tmux.layout.terminalToggle": "z",
  /** Zen mode: collapse to the engine pane (file + terminal, and Tasks unless kept). */
  "tmux.layout.zenToggle": "space",
} as const

/**
 * 0.7.30 briefly shipped layout controls as no-prefix F6-F11 root bindings.
 * Always unbind these during session setup so a long-lived tmux server does not
 * keep stale root keys after the defaults move to prefix-table bindings.
 */
export const TMUX_LEGACY_LAYOUT_ROOT_KEYS = ["F6", "F7", "F8", "F9", "F10", "F11"] as const

/** Single-chord tmux binding ids. `tmux.focus` (the 4-chord group) is separate. */
export const TMUX_SINGLE_BINDING_DEFAULTS = {
  ...TMUX_ROOT_BINDING_DEFAULTS,
  ...TMUX_PREFIX_BINDING_DEFAULTS,
} as const

export type TmuxSingleBindingId = keyof typeof TMUX_SINGLE_BINDING_DEFAULTS
export type TmuxPrefixBindingId = keyof typeof TMUX_PREFIX_BINDING_DEFAULTS

export function isTmuxPrefixBindingId(id: string): id is TmuxPrefixBindingId {
  return id in TMUX_PREFIX_BINDING_DEFAULTS
}

/** Directional pane-focus group: POSITIONAL, order left / down / up / right. */
export const TMUX_FOCUS_ID = "tmux.focus"
export const TMUX_FOCUS_DEFAULTS = ["ctrl+h", "ctrl+j", "ctrl+k", "ctrl+l"] as const

const TMUX_NAMED_KEYS: Readonly<Record<string, string>> = {
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  pageup: "PgUp",
  pagedown: "PgDn",
  home: "Home",
  end: "End",
  insert: "IC",
  delete: "DC",
  backspace: "BSpace",
  tab: "Tab",
  space: "Space",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
}

export type TmuxKeyResult = { key: string } | { error: string }

/**
 * Translate a NORMALIZED kobe chord (`ctrl+t`, `ctrl+shift+t`, `f2`,
 * `alt+pageup`) into tmux bind-key syntax (`C-t`, `C-S-T`, `F2`,
 * `M-PgUp`), or explain why tmux can't bind it.
 */
export function chordToTmuxKey(chord: string, opts?: { allowBare?: boolean }): TmuxKeyResult {
  const parts = chord.split("+")
  let key = parts.pop() ?? ""
  if (key === "" && parts.length > 0) {
    key = "+"
    if (parts[parts.length - 1] === "") parts.pop()
  }
  const mods = new Set(parts)
  if (mods.has("cmd")) {
    return { error: `"${chord}": the Command key never reaches tmux — use ctrl/alt/shift` }
  }

  let tmuxKey: string
  if (key.length === 1) {
    // Shifted single characters follow tmux's C-S-T spelling (uppercase
    // letter; needs an extended-keys terminal, same as the default
    // ctrl+shift+t engine-tab chord).
    tmuxKey = mods.has("shift") ? key.toUpperCase() : key
  } else {
    const named = TMUX_NAMED_KEYS[key]
    if (!named) return { error: `"${chord}": tmux can't bind the key "${key}"` }
    tmuxKey = named
  }

  const isFKey = /^f\d+$/.test(key)
  if (mods.size === 0 && !isFKey && !opts?.allowBare) {
    return {
      error: `"${chord}": tmux session keys are no-prefix root bindings live in every pane — a bare key would shadow typing (add a modifier, or use an F-key)`,
    }
  }

  // tmux prefix order C-, M-, then S- (S- only for non-letter keys; the
  // letter case carries shift above — but C-S-T spells it explicitly, so
  // include S- whenever shift was requested).
  let prefix = ""
  if (mods.has("ctrl")) prefix += "C-"
  if (mods.has("alt")) prefix += "M-"
  if (mods.has("shift")) prefix += "S-"
  return { key: prefix + tmuxKey }
}

export type TmuxResolvedBind = { chord: string; key: string }

export type TmuxKeyResolution = {
  /** Per single-binding id: the bind to install, or null = leave unbound. */
  binds: Record<TmuxSingleBindingId, TmuxResolvedBind | null>
  /** Focus group, order left/down/up/right; entries null when unbound. */
  focus: ReadonlyArray<TmuxResolvedBind | null>
  /** Ids whose value differs from the default → installer must unbind the default key. */
  overridden: ReadonlySet<string>
  warnings: string[]
}

function defaultResolution(): TmuxKeyResolution {
  const binds = {} as Record<TmuxSingleBindingId, TmuxResolvedBind | null>
  for (const [id, chord] of Object.entries(TMUX_SINGLE_BINDING_DEFAULTS)) {
    const t = chordToTmuxKey(chord, { allowBare: isTmuxPrefixBindingId(id) })
    if ("error" in t) throw new Error(`default tmux chord for ${id} failed to translate: ${t.error}`)
    binds[id as TmuxSingleBindingId] = { chord, key: t.key }
  }
  const focus = TMUX_FOCUS_DEFAULTS.map((chord) => {
    const t = chordToTmuxKey(chord)
    if ("error" in t) throw new Error(`default tmux focus chord ${chord} failed to translate`)
    return { chord, key: t.key }
  })
  return { binds, focus, overridden: new Set(), warnings: [] }
}

/**
 * Apply `tmux.*` override entries onto the default tmux key set. Pure;
 * entries usually come from `extractKeybindingOverrides`. Non-`tmux.*`
 * ids are ignored (they belong to the opentui keymap).
 */
export function resolveTmuxKeyEntries(entries: readonly KeymapOverrideEntry[]): TmuxKeyResolution {
  const res = defaultResolution()
  const overridden = new Set<string>()
  for (const entry of entries) {
    if (!entry.id.startsWith("tmux.")) continue

    if (entry.id === TMUX_FOCUS_ID) {
      if (entry.keys.length === 0) {
        res.focus = [null, null, null, null]
        overridden.add(TMUX_FOCUS_ID)
        continue
      }
      if (entry.keys.length !== TMUX_FOCUS_DEFAULTS.length) {
        res.warnings.push(
          `${TMUX_FOCUS_ID}: needs exactly 4 chords in order left/down/up/right (got ${entry.keys.length}) — keeping the default`,
        )
        continue
      }
      const translated: TmuxResolvedBind[] = []
      let ok = true
      for (const chord of entry.keys) {
        const t = chordToTmuxKey(chord)
        if ("error" in t) {
          res.warnings.push(`${TMUX_FOCUS_ID}: ${t.error} — keeping the default`)
          ok = false
          break
        }
        translated.push({ chord, key: t.key })
      }
      if (!ok) continue
      res.focus = translated
      overridden.add(TMUX_FOCUS_ID)
      continue
    }

    if (!(entry.id in TMUX_SINGLE_BINDING_DEFAULTS)) {
      res.warnings.push(`${entry.id}: unknown tmux binding id`)
      continue
    }
    const id = entry.id as TmuxSingleBindingId
    if (entry.keys.length === 0) {
      res.binds[id] = null
      overridden.add(id)
      continue
    }
    if (entry.keys.length > 1) {
      res.warnings.push(`${id}: tmux bindings take ONE chord — using "${entry.keys[0]}", ignoring the rest`)
    }
    const chord = entry.keys[0] as string
    const t = chordToTmuxKey(chord, { allowBare: isTmuxPrefixBindingId(id) })
    if ("error" in t) {
      res.warnings.push(`${id}: ${t.error} — keeping the default`)
      continue
    }
    if (chord !== TMUX_SINGLE_BINDING_DEFAULTS[id]) overridden.add(id)
    res.binds[id] = { chord, key: t.key }
  }
  res.overridden = overridden
  return res
}

/** Chord-normalization options for the shared extractor: tmux ids may use shift+letter. */
export function tmuxChordOptsFor(id: string): { allowShiftCharacter?: boolean } {
  return id.startsWith("tmux.") ? { allowShiftCharacter: true } : {}
}

let cached: TmuxKeyResolution | null = null

/**
 * Drop the cached resolution so the next {@link resolveUserTmuxKeys}
 * re-reads. Used by the live-reload path (`reloadUserKeybindings`) so the
 * Tasks-pane footer's tmux hints re-derive from the edited file. NOTE: this
 * only refreshes the DISPLAY — the tmux session keys themselves are bound on
 * the tmux server at session build, so their BEHAVIOR still needs a rebuild.
 */
export function resetTmuxKeysCache(): void {
  cached = null
}

/**
 * The tmux key set for THIS process, from the user's keybindings YAML.
 * Cached (the file reader is cached too); warnings are console-logged
 * once here — the Settings → Keybindings section reports them separately
 * via the opentui loader, which calls the pure half of this module.
 */
export function resolveUserTmuxKeys(): TmuxKeyResolution {
  if (cached) return cached
  const file = readKeybindingsFile()
  if (!file.exists || file.doc === null) {
    cached = defaultResolution()
    return cached
  }
  const extracted = extractKeybindingOverrides(file.doc, process.platform, { chordOptsFor: tmuxChordOptsFor })
  // Only surface tmux-namespace extraction warnings here; the opentui
  // loader owns the rest (and the file-level warnings).
  const tmuxWarnings = extracted.warnings.filter((w) => w.startsWith("tmux."))
  const res = resolveTmuxKeyEntries(extracted.entries)
  res.warnings = [...tmuxWarnings, ...res.warnings]
  for (const w of res.warnings) console.warn(`[kobe/keybindings] ${w}`)
  cached = res
  return cached
}
