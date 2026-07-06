export type OverridableHint = {
  keys: string
  label: string
  status?: false
  pin?: "right"
}

export type OverridableBinding = {
  id: string
  scope: string
  keys: readonly string[]
  hint?: OverridableHint
}

export type KeymapOverrideEntry = { id: string; keys: string[] }

export type AppliedOverride = {
  id: string
  keys: readonly string[]
  defaultKeys: readonly string[]
}

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

export type SlotContract = {
  layout: string
  validateCount: (count: number) => string | null
}

function pairContract(first: string, second: string): SlotContract {
  const layout = `alternating [${first}, ${second}] pairs`
  return {
    layout,
    validateCount: (count) =>
      count >= 2 && count % 2 === 0 ? null : `needs ${layout} (an even number of chords — got ${count})`,
  }
}

export const SLOT_CONTRACTS: Readonly<Record<string, SlotContract>> = {
  "sidebar.nav": pairContract("down", "up"),
  "files.nav": pairContract("down", "up"),
  "sidebar.search.nav": pairContract("down", "up"),
  "files.hierarchy": pairContract("collapse", "expand"),
  "sidebar.view": pairContract("previous view", "next view"),
  "files.tab": pairContract("previous tab", "next tab"),
  "app.quit": {
    layout: "[quit confirm, hard exit] (second chord optional)",
    validateCount: (count) => (count <= 2 ? null : `needs [quit confirm, hard exit] (1 or 2 chords — got ${count})`),
  },
}

const NO_BARE_LETTER_SCOPES = new Set(["global", "workspace", "terminal"])

const MOD_ALIASES: Readonly<Record<string, "ctrl" | "cmd" | "alt" | "shift">> = {
  ctrl: "ctrl",
  control: "ctrl",
  ctl: "ctrl",
  cmd: "cmd",
  command: "cmd",
  meta: "cmd",
  super: "cmd",
  win: "cmd",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
}

const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: "escape",
  spacebar: "space",
  pgup: "pageup",
  pgdn: "pagedown",
  pgdown: "pagedown",
}

const KNOWN_NAMED_KEYS = new Set([
  "up",
  "down",
  "left",
  "right",
  "pageup",
  "pagedown",
  "home",
  "end",
  "insert",
  "delete",
  "backspace",
  "tab",
  "space",
  "escape",
  "enter",
  "return",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
])

const MOD_ORDER: ReadonlyArray<"ctrl" | "cmd" | "alt" | "shift"> = ["ctrl", "cmd", "alt", "shift"]

export type ChordResult = { chord: string; warning?: string } | { error: string }

export type NormalizeChordOpts = {
  allowShiftCharacter?: boolean
}

export function normalizeChord(raw: string, opts?: NormalizeChordOpts): ChordResult {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return { error: "empty chord" }

  const parts = trimmed.split("+")
  let key = parts.pop() ?? ""
  if (key === "" && parts.length > 0 && parts[parts.length - 1] === "") {
    key = "+"
    parts.pop()
  }
  if (!key) return { error: `"${raw}": no key after the modifiers` }

  const mods = new Set<"ctrl" | "cmd" | "alt" | "shift">()
  for (const part of parts) {
    const mod = MOD_ALIASES[part]
    if (!mod) return { error: `"${raw}": unknown modifier "${part}" (use ctrl / cmd / alt / shift)` }
    mods.add(mod)
  }

  key = KEY_ALIASES[key] ?? key

  if (mods.has("shift") && key.length === 1 && !opts?.allowShiftCharacter) {
    return {
      error: `"${raw}": shift+<character> can never match — terminals deliver shift+letter as a plain character, not a modifier event`,
    }
  }

  const prefix = MOD_ORDER.filter((m) => mods.has(m)).join("+")
  const chord = prefix ? `${prefix}+${key}` : key

  if (key.length > 1 && !KNOWN_NAMED_KEYS.has(key)) {
    return { chord, warning: `"${raw}": unrecognized key name "${key}" — the chord may never fire` }
  }
  return { chord }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function platformSectionNames(platform: string): string[] {
  if (platform === "darwin") return ["darwin", "macos", "mac"]
  if (platform === "win32") return ["win32", "windows"]
  return [platform]
}

function extractBindingsMap(section: unknown): Record<string, unknown> | null {
  if (!isRecord(section)) return null
  const nested = section.bindings
  if (isRecord(nested)) return nested
  return section
}

export type ExtractOverridesOpts = {
  chordOptsFor?: (id: string) => NormalizeChordOpts
}

export function extractKeybindingOverrides(
  doc: unknown,
  platform: string,
  opts?: ExtractOverridesOpts,
): { entries: KeymapOverrideEntry[]; warnings: string[] } {
  const warnings: string[] = []
  if (doc === null || doc === undefined) return { entries: [], warnings }
  if (!isRecord(doc)) {
    return { entries: [], warnings: ["config root must be a YAML mapping (e.g. a top-level `bindings:` key)"] }
  }

  const merged = new Map<string, string[]>()

  const layers: Array<Record<string, unknown>> = []
  if (doc.bindings !== undefined) {
    if (isRecord(doc.bindings)) layers.push(doc.bindings)
    else warnings.push("`bindings:` must be a mapping of id → chord(s)")
  }
  for (const name of platformSectionNames(platform)) {
    const section = doc[name]
    if (section === undefined) continue
    const map = extractBindingsMap(section)
    if (map) layers.push(map)
    else warnings.push(`\`${name}:\` must be a mapping (or contain a \`bindings:\` mapping)`)
  }

  for (const layer of layers) {
    for (const [id, value] of Object.entries(layer)) {
      if (value === null || value === false || (Array.isArray(value) && value.length === 0)) {
        merged.set(id, [])
        continue
      }
      const rawChords = typeof value === "string" ? [value] : Array.isArray(value) ? value : null
      if (!rawChords) {
        warnings.push(`${id}: expected a chord string, a list of chords, or null — got ${typeof value}`)
        continue
      }
      const chords: string[] = []
      let anyError = false
      for (const rawChord of rawChords) {
        if (typeof rawChord !== "string") {
          warnings.push(`${id}: chord entries must be strings`)
          anyError = true
          continue
        }
        const result = normalizeChord(rawChord, opts?.chordOptsFor?.(id))
        if ("error" in result) {
          warnings.push(`${id}: ${result.error}`)
          anyError = true
          continue
        }
        if (result.warning) warnings.push(`${id}: ${result.warning}`)
        if (!chords.includes(result.chord)) chords.push(result.chord)
      }
      if (chords.length === 0 && anyError) {
        warnings.push(`${id}: no valid chords — keeping the default`)
        continue
      }
      merged.set(id, chords)
    }
  }

  return {
    entries: Array.from(merged, ([id, keys]) => ({ id, keys })),
    warnings,
  }
}

function scopesOverlap(a: string, b: string): boolean {
  return a === b || a === "global" || b === "global"
}

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

    const contract = SLOT_CONTRACTS[entry.id]
    if (contract && entry.keys.length > 0) {
      const problem = contract.validateCount(entry.keys.length)
      if (problem) {
        warnings.push(`${entry.id}: ${problem} — keeping the default`)
        continue
      }
    }

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
        mutable.hint = undefined
      } else {
        row.hint.keys = keys.join("/")
      }
    }
    applied.push({ id: entry.id, keys, defaultKeys })
  }

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
