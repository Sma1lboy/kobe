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

export function tmuxPrefixGlyph(raw: string): string | null {
  const value = raw.trim().split(/\s+/).pop() ?? ""
  const m = /^([CM])-(.+)$/.exec(value)
  if (!m) return null
  const mod = m[1] === "C" ? "⌃" : "⌥"
  const key = m[2] ?? ""
  return `${mod}${key.length === 1 ? key.toUpperCase() : key}`
}

function formatKey(k: string, upper: boolean): string {
  if (k.includes("/")) {
    return k
      .split("/")
      .map((part) => formatKey(part, upper))
      .join("/")
  }
  const low = k.toLowerCase()
  if (low === "tab") return "tab"
  const named = KEY_GLYPH[low]
  if (named) return named
  if (/^f\d{1,2}$/.test(low)) return low.toUpperCase()
  if (!upper) return k
  if (/^[a-z]$/.test(low)) return k.toUpperCase()
  return k.replace(/[a-z]+/gi, (run) => run.toUpperCase())
}

export function formatChord(chord: string, prefixGlyph = "⌃B"): string {
  const s = chord.trim()
  if (!s) return s
  const pm = /^prefix\s+(.+)$/i.exec(s)
  if (pm) {
    const suffix = pm[1] ?? ""
    return `${prefixGlyph} ${suffix.includes("+") ? formatChord(suffix, prefixGlyph) : formatKey(suffix, true)}`
  }
  const parts = s.split("+")
  if (parts.length === 1) return formatKey(parts[0] ?? "", false)
  const key = parts[parts.length - 1] ?? ""
  const mods = parts.slice(0, -1).map((p) => MODIFIER_GLYPH[p.toLowerCase().trim()] ?? p)
  return `${mods.join("")} ${formatKey(key, true)}`
}
