import { readKeybindingsFile } from "../state/keybindings-file"
import { type KeymapOverrideEntry, extractKeybindingOverrides, normalizeChord } from "../tui/lib/keymap-overrides"

export const TMUX_ROOT_BINDING_DEFAULTS = {
  "tmux.detach": "ctrl+q",
  "tmux.tab.new": "ctrl+t",
  "tmux.tab.chooseEngine": "ctrl+shift+t",
  "tmux.tab.prev": "ctrl+[",
  "tmux.tab.next": "ctrl+]",
  "tmux.tab.close": "ctrl+w",
  "tmux.tab.rename": "f2",
} as const

export const TMUX_PREFIX_BINDING_DEFAULTS = {
  "tmux.layout.workspaceSplit": "s",
  "tmux.layout.workspaceClose": "x",
  "tmux.layout.workspaceReset": "r",
  "tmux.layout.tasksToggle": "a",
  "tmux.layout.opsToggle": "o",
  "tmux.layout.terminalToggle": "z",
  "tmux.layout.zenToggle": "space",
} as const

export const TMUX_LEGACY_LAYOUT_ROOT_KEYS = ["F6", "F7", "F8", "F9", "F10", "F11"] as const

export const TMUX_SINGLE_BINDING_DEFAULTS = {
  ...TMUX_ROOT_BINDING_DEFAULTS,
  ...TMUX_PREFIX_BINDING_DEFAULTS,
} as const

export type TmuxSingleBindingId = keyof typeof TMUX_SINGLE_BINDING_DEFAULTS
export type TmuxPrefixBindingId = keyof typeof TMUX_PREFIX_BINDING_DEFAULTS

export function isTmuxPrefixBindingId(id: string): id is TmuxPrefixBindingId {
  return id in TMUX_PREFIX_BINDING_DEFAULTS
}

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

  let prefix = ""
  if (mods.has("ctrl")) prefix += "C-"
  if (mods.has("alt")) prefix += "M-"
  if (mods.has("shift")) prefix += "S-"
  return { key: prefix + tmuxKey }
}

export type TmuxResolvedBind = { chord: string; key: string }

export type TmuxKeyResolution = {
  binds: Record<TmuxSingleBindingId, TmuxResolvedBind | null>
  focus: ReadonlyArray<TmuxResolvedBind | null>
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

export function tmuxChordOptsFor(id: string): { allowShiftCharacter?: boolean } {
  return id.startsWith("tmux.") ? { allowShiftCharacter: true } : {}
}

let cached: TmuxKeyResolution | null = null

export function resetTmuxKeysCache(): void {
  cached = null
}

export function resolveUserTmuxKeys(): TmuxKeyResolution {
  if (cached) return cached
  const file = readKeybindingsFile()
  if (!file.exists || file.doc === null) {
    cached = defaultResolution()
    return cached
  }
  const extracted = extractKeybindingOverrides(file.doc, process.platform, { chordOptsFor: tmuxChordOptsFor })
  const tmuxWarnings = extracted.warnings.filter((w) => w.startsWith("tmux."))
  const res = resolveTmuxKeyEntries(extracted.entries)
  res.warnings = [...tmuxWarnings, ...res.warnings]
  for (const w of res.warnings) console.warn(`[kobe/keybindings] ${w}`)
  cached = res
  return cached
}
