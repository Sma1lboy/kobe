/**
 * Chord grammar + YAML-document extraction for user keybinding
 * overrides (~/.kobe/settings/keybindings.yaml).
 *
 * Split out of `keymap-overrides.ts` (which keeps the apply/validation
 * policy and re-exports everything here) so the parsing half — chord
 * normalization and document extraction — stays a self-contained,
 * zero-opentui module both the TUI loader and the tmux-layer resolver
 * share.
 *
 * Config shape (per-field optional):
 *
 * ```yaml
 * bindings:                 # applies on every platform
 *   chat.fork.new: ctrl+g   # string = single chord
 *   sidebar.select: [enter] # list  = multiple chords (all fire the action)
 *   files.createPR: null    # null / [] = unbind
 * darwin:                   # platform overlay — wins over `bindings`
 *   bindings:
 *     palette.open: [cmd+p, ctrl+p]
 * linux:
 *   bindings:
 *     palette.open: ctrl+p
 * ```
 *
 * Platform sections: `darwin` (aliases `macos` / `mac`), `linux`, `win32`
 * (alias `windows`) — matched against `process.platform`. An entry in the
 * platform overlay replaces the SAME id's entry from `bindings:` wholesale
 * (no per-chord merge).
 *
 * Chord grammar mirrors `matchKey()` (keymap-dispatch.ts) — the override
 * must produce exactly the candidate string the dispatcher mints:
 *   - `mod+...+key`, modifiers in any order/alias; canonicalized to the
 *     dispatcher's order: ctrl, cmd, alt, shift.
 *   - aliases: control/ctl→ctrl, command/meta/super/win→cmd,
 *     option/opt→alt, esc→escape, pgup/pgdn→pageup/pagedown.
 *   - `shift+<single char>` is rejected: terminals deliver shift+letter as
 *     a plain (uppercase) character, never as a shift-modified event, so
 *     such a chord can never match.
 *   - left/right ARROW keys are just `left` / `right`; left vs right
 *     MODIFIER keys cannot be told apart by terminal protocols, so there
 *     is no `lctrl`/`rcmd` syntax.
 */

/** One requested override after extraction: `keys: []` means "unbind". */
export type KeymapOverrideEntry = { id: string; keys: string[] }

/** Extraction result: direct-chord overrides, prefix-stroke overrides, warnings. */
export type ExtractedKeybindingOverrides = {
  entries: KeymapOverrideEntry[]
  prefixEntries: KeymapOverrideEntry[]
  warnings: string[]
}

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

/**
 * Named keys opentui is known to deliver via `evt.name`. A key outside
 * this set (and not a single character) still APPLIES, but with a "may
 * never fire" warning — the list is descriptive, not a hard gate, so a
 * terminal-specific name we haven't catalogued isn't rejected.
 */
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

/** Canonical modifier order — MUST match `matchKey()`'s prefix order. */
const MOD_ORDER: ReadonlyArray<"ctrl" | "cmd" | "alt" | "shift"> = ["ctrl", "cmd", "alt", "shift"]

export type ChordResult = { chord: string; warning?: string } | { error: string }

export type NormalizeChordOpts = {
  /**
   * Permit `shift+<single char>` chords. The opentui keymap layer can
   * never match them (terminals deliver shift+letter as a plain
   * character), but tmux CAN bind `C-S-T` on extended-keys terminals —
   * the tmux-layer resolver opts in; everything else keeps the rejection.
   */
  allowShiftCharacter?: boolean
}

/**
 * Normalize one user-written chord into the exact candidate string
 * `matchKey()` mints, or explain why it can't work.
 */
export function normalizeChord(raw: string, opts?: NormalizeChordOpts): ChordResult {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return { error: "empty chord" }

  // Split on "+", then read the trailing token. A trailing "+" leaves an
  // empty final token; whether that means "the literal plus key" or "a
  // dangling modifier with no key" is decided by the part BEFORE it:
  //   "ctrl++" → ["ctrl", "", ""] — an empty marker part precedes, so "+"
  //              is the key; drop the marker.
  //   "+"      → ["", ""]         — the plus key on its own.
  //   "ctrl+"  → ["ctrl", ""]     — a real modifier precedes, so there is
  //              no key; fall through to the error below.
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

/** Platform-section spellings accepted in the YAML, per process.platform. */
function platformSectionNames(platform: string): string[] {
  if (platform === "darwin") return ["darwin", "macos", "mac"]
  if (platform === "win32") return ["win32", "windows"]
  return [platform]
}

function extractBindingsMap(section: unknown): Record<string, unknown> | null {
  if (!isRecord(section)) return null
  // Accept both `darwin: { bindings: {...} }` and `darwin: {...}` flat.
  const nested = section.bindings
  if (isRecord(nested)) return nested
  return section
}

export type ExtractOverridesOpts = {
  /** Per-id chord-normalization options for specialized consumers. */
  chordOptsFor?: (id: string) => NormalizeChordOpts
}

/**
 * Turn a parsed YAML document into a flat override list for `platform`.
 * Never throws; malformed pieces degrade to warnings. Each warning string
 * is prefixed `"<id>: "` when it concerns a specific binding.
 */
export function extractKeybindingOverrides(
  doc: unknown,
  platform: string,
  opts?: ExtractOverridesOpts,
): ExtractedKeybindingOverrides {
  const warnings: string[] = []
  if (doc === null || doc === undefined) return { entries: [], prefixEntries: [], warnings }
  if (!isRecord(doc)) {
    return {
      entries: [],
      prefixEntries: [],
      warnings: ["config root must be a YAML mapping (e.g. a top-level `bindings:` key)"],
    }
  }

  // id → keys, base layer first, platform overlay replacing per id.
  const merged = new Map<string, string[]>()
  const prefixMerged = new Map<string, string[]>()

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
      const modeValues =
        isRecord(value) && ("direct" in value || "prefix" in value)
          ? ([
              [merged, value.direct],
              [prefixMerged, value.prefix],
            ] as const)
          : ([[merged, value]] as const)
      for (const [target, modeValue] of modeValues) {
        if (modeValue === undefined) continue
        // Unbind spellings: null / false / empty list.
        if (modeValue === null || modeValue === false || (Array.isArray(modeValue) && modeValue.length === 0)) {
          target.set(id, [])
          continue
        }
        const rawChords = typeof modeValue === "string" ? [modeValue] : Array.isArray(modeValue) ? modeValue : null
        if (!rawChords) {
          warnings.push(`${id}: expected a chord string, a list of chords, or null — got ${typeof modeValue}`)
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
        target.set(id, chords)
      }
    }
  }

  return {
    entries: Array.from(merged, ([id, keys]) => ({ id, keys })),
    prefixEntries: Array.from(prefixMerged, ([id, keys]) => ({ id, keys })),
    warnings,
  }
}
