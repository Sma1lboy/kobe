/**
 * Pure logic for user keybinding overrides (~/.kobe/settings/keybindings.yaml).
 *
 * Split out of the loader (`src/tui/context/keybindings-user.ts`) for the
 * same reason `keymap-dispatch.ts` is split out of `keymap.tsx`: vitest
 * can't import `@opentui/*` (transitive `.scm` assets), so everything
 * testable — chord normalization, document extraction, validation, the
 * keymap mutation — lives here with zero opentui imports. The loader is a
 * thin Bun-runtime wrapper (read file → `Bun.YAML.parse` → these functions).
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
 *     such a chord can never match (see docs/KEYBINDINGS.md decision log).
 *   - left/right ARROW keys are just `left` / `right`; left vs right
 *     MODIFIER keys cannot be told apart by terminal protocols, so there
 *     is no `lctrl`/`rcmd` syntax.
 */

export type OverridableHint = {
  keys: string
  label: string
  status?: false
  pin?: "right"
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

/** One requested override after extraction: `keys: []` means "unbind". */
export type KeymapOverrideEntry = { id: string; keys: string[] }

/** One override that actually landed on the keymap. */
export type AppliedOverride = {
  id: string
  keys: readonly string[]
  defaultKeys: readonly string[]
}

/**
 * Ids whose handlers discriminate BETWEEN their chords by `evt.name` /
 * `evt.shift` (e.g. `sidebar.nav` runs moveDown for `j`/`down` and moveUp
 * for `k`/`up`). Rebinding the chord list would silently break the
 * direction mapping, so these are fixed until the handlers learn
 * slot-based dispatch. Value = the reason shown in warnings / settings.
 */
export const FIXED_BINDING_IDS: Readonly<Record<string, string>> = {
  "focus.numeric": "pane focus is positional (h/j/k/l → pane) and mirrors the tmux-layer ctrl+hjkl bindings",
  "sidebar.nav": "handler maps j/down vs k/up by key name",
  "sidebar.goto": "gg vs Shift+G is discriminated inside the handler",
  "sidebar.pin": "Shift+P is discriminated inside the handler",
  "sidebar.localMerge": "Shift+M is discriminated inside the handler",
  "sidebar.view": "[ vs ] direction is read from the key name",
  "sidebar.search.nav": "handler maps down vs up by key name",
  "files.nav": "handler maps j/down vs k/up by key name",
  "files.hierarchy": "handler maps h/left vs l/right by key name",
  "files.tab": "[ vs ] direction is read from the key name",
  "chat.question.nav": "handler maps j/down vs k/up by key name",
  "chat.question.pick-number": "digits map to options by key name",
}

/** Scopes where a bare single-character chord would steal typed input. */
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

  // Split on "+" but let a trailing "+" mean the literal plus key
  // ("ctrl++" = ctrl plus "+", like the pane.resize-grow default).
  const parts = trimmed.split("+")
  let key = parts.pop() ?? ""
  if (key === "" && parts.length > 0) {
    key = "+"
    // "ctrl++" splits to ["ctrl", "", ""] — drop the empty marker part.
    if (parts[parts.length - 1] === "") parts.pop()
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
  /**
   * Per-id chord-normalization options. The tmux-layer resolver passes
   * `(id) => id.startsWith("tmux.") ? { allowShiftCharacter: true } : {}`
   * so `tmux.tab.chooseEngine: ctrl+shift+t` round-trips while opentui
   * ids keep the shift+letter rejection.
   */
  chordOptsFor?: (id: string) => NormalizeChordOpts
}

/**
 * Turn a parsed YAML document into a flat override list for `platform`.
 * Never throws; malformed pieces degrade to warnings. Each warning string
 * is prefixed `"<id>: "` when it concerns a specific binding — consumers
 * that split the id namespace (opentui vs tmux) filter on that prefix.
 */
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

  // id → keys, base layer first, platform overlay replacing per id.
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
      // Unbind spellings: null / false / empty list.
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

/** True when two binding scopes can both be live for the same keypress. */
function scopesOverlap(a: string, b: string): boolean {
  return a === b || a === "global" || b === "global"
}

/**
 * Validate the requested overrides against `keymap` and apply the
 * survivors by MUTATING the matching rows in place (`keys`, plus a
 * refreshed `hint.keys` so the status bar / help dialog advertise the
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
