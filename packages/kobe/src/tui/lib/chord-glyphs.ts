/**
 * macOS-style keyboard glyphs for chord display.
 *
 * kobe stores chords as machine strings (`ctrl+q`, `shift+tab`, `prefix f`,
 * `j/k`) but renders them in the footer, the F1 help dialog, and the status
 * bar. This is the single place that turns a chord into the glyphs a Mac user
 * expects — `⌃Q`, `⇧⇥`, `⌃B F`, `J/K` — so every surface reads the same.
 *
 * Conventions: modifier glyphs are concatenated (`⌃⇧`), then a SPACE, then the
 * key (`⌃⇧ T`, `⌃ Q`) so the modifier icons read separately from the letter;
 * letters uppercase; named keys become their glyph (`⏎ ⎋ ↑`) EXCEPT `tab`,
 * which stays the word `tab` (a glyph is overkill for it); a tmux `prefix X`
 * chord is a TWO-step chord, shown as `<prefix glyph> X`.
 */

const MODIFIER_GLYPH: Record<string, string> = {
  ctrl: "⌃",
  control: "⌃",
  alt: "⌥",
  opt: "⌥",
  option: "⌥",
  shift: "⇧",
  cmd: "⌘",
  command: "⌘",
  meta: "⌘",
  super: "⌘",
}

const KEY_GLYPH: Record<string, string> = {
  enter: "⏎",
  return: "⏎",
  esc: "⎋",
  escape: "⎋",
  space: "␣",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  backspace: "⌫",
  delete: "⌦",
  del: "⌦",
  pgup: "⇞",
  pageup: "⇞",
  pgdn: "⇟",
  pagedown: "⇟",
  home: "↖",
  end: "↘",
}

/**
 * Parse a `tmux show-options -g prefix` value (`prefix C-b` / `C-b` / `M-x`)
 * into a key cap (`⌃B`, `⌥X`). Returns null for anything unparseable so the
 * caller can fall back to a literal (the default prefix is `⌃B`).
 */
export function tmuxPrefixGlyph(raw: string): string | null {
  const value = raw.trim().split(/\s+/).pop() ?? ""
  const m = /^([CM])-(.+)$/.exec(value)
  if (!m) return null
  const mod = m[1] === "C" ? "⌃" : "⌥"
  const key = m[2] ?? ""
  return `${mod}${key.length === 1 ? key.toUpperCase() : key}`
}

/**
 * Format a single key token (the part after any modifiers). `upper` uppercases
 * letters — true for a MODIFIER chord (mac style: `⌃ Q`), false for a BARE key
 * so a plain-letter chord stays the literal key you press (`n`, not `N`), and a
 * deliberately-capital one (`M` = Shift+M) keeps its case.
 */
function formatKey(k: string, upper: boolean): string {
  // Compound key display like `j/k`, `h/l`, `enter/esc`, `[/]`: format each
  // side so a multi-key hint renders `j/k` / `⏎/⎋`, not `ENTER/ESC`.
  if (k.includes("/")) {
    return k
      .split("/")
      .map((part) => formatKey(part, upper))
      .join("/")
  }
  const low = k.toLowerCase()
  if (low === "tab") return "tab" // tab needs no glyph — just the word
  const named = KEY_GLYPH[low]
  if (named) return named
  if (/^f\d{1,2}$/.test(low)) return low.toUpperCase() // f1 → F1 (function keys)
  if (!upper) return k // bare key: keep as typed (n, M, j/k pieces, symbols)
  if (/^[a-z]$/.test(low)) return k.toUpperCase() // modified single letter → uppercase
  return k.replace(/[a-z]+/gi, (run) => run.toUpperCase()) // modified composite (hjkl → HJKL)
}

/**
 * Turn a chord / display string into macOS key glyphs. `prefixGlyph` (default
 * `⌃B`, the tmux default) renders `prefix X` chords as `⌃B X`.
 *
 *   formatChord("ctrl+q")      → "⌃ Q"
 *   formatChord("shift+tab")   → "⇧ tab"
 *   formatChord("ctrl+enter")  → "⌃ ⏎"
 *   formatChord("prefix f")    → "⌃B F"
 *   formatChord("j/k")         → "J/K"
 *   formatChord("ctrl+hjkl")   → "⌃ HJKL"
 */
export function formatChord(chord: string, prefixGlyph = "⌃B"): string {
  const s = chord.trim()
  if (!s) return s
  const pm = /^prefix\s+(.+)$/i.exec(s)
  if (pm) return `${prefixGlyph} ${formatKey(pm[1] ?? "", true)}`
  const parts = s.split("+")
  if (parts.length === 1) return formatKey(parts[0] ?? "", false) // bare key — keep its case
  const key = parts[parts.length - 1] ?? ""
  const mods = parts.slice(0, -1).map((p) => MODIFIER_GLYPH[p.toLowerCase().trim()] ?? p)
  // Modifier-icon cluster, a SPACE, then the (uppercased) key.
  return `${mods.join("")} ${formatKey(key, true)}`
}
