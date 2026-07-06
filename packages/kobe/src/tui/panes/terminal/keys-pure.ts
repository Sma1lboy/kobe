import type { KeyEvent } from "@opentui/core"

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the raw ESC-prefixed kitty wire encoding is the whole point
const KITTY_CSI_U_RE = /^\x1b\[[\d:;]*u$/

const CTRL_PUNCT_C0: Record<string, string> = {
  "@": "\x00",
  "[": "\x1b",
  "\\": "\x1c",
  "]": "\x1d",
  "^": "\x1e",
  _: "\x1f",
  "?": "\x7f",
}

export function keyEventToShellBytes(evt: KeyEvent): string | null {
  const e = evt as KeyEvent & { sequence?: string; raw?: string }
  const seq = typeof e.sequence === "string" && e.sequence.length > 0 ? e.sequence : null
  const kittyWire =
    (typeof e.raw === "string" && KITTY_CSI_U_RE.test(e.raw)) || (seq != null && KITTY_CSI_U_RE.test(seq))
  if (seq != null && !kittyWire) return seq
  return synthesizeShellBytes(evt)
}

function synthesizeShellBytes(evt: KeyEvent): string | null {
  const name = evt.name
  if (!name) return null

  if (evt.shift && name === "tab") return "\x1b[Z"
  if (evt.option || evt.meta) {
    const inner = synthesizeShellBytes({ ...evt, option: false, meta: false } as KeyEvent)
    return inner == null ? null : `\x1b${inner}`
  }

  switch (name) {
    case "return":
    case "enter":
      return "\r"
    case "tab":
      return "\t"
    case "backspace":
      return "\x7f"
    case "delete":
      return "\x1b[3~"
    case "up":
      return "\x1b[A"
    case "down":
      return "\x1b[B"
    case "right":
      return "\x1b[C"
    case "left":
      return "\x1b[D"
    case "home":
      return "\x1b[H"
    case "end":
      return "\x1b[F"
    case "escape":
      return "\x1b"
    case "space":
      return evt.ctrl ? "\x00" : " "
    default:
      if (name.length === 1) {
        if (evt.ctrl) {
          const lower = name.toLowerCase()
          const code = lower.charCodeAt(0)
          if (code >= 0x61 && code <= 0x7a) return String.fromCharCode(code - 0x60)
          const c0 = CTRL_PUNCT_C0[name]
          if (c0 != null) return c0
          return null
        }
        return name
      }
      return null
  }
}

export const DEFAULT_PAGE_SIZE = 10

export const TRAPPED_KEYS = ["ctrl+pageup", "ctrl+pagedown"] as const

export const RESERVED_GLOBAL_CHORDS: readonly string[] = [
  "ctrl+q",
  "ctrl+t",
  "ctrl+w",
  "ctrl+]",
  "ctrl+[",
  "f2",
  "ctrl+e",
  "ctrl+\\",
  "ctrl+=",
  "f3",
  "f5",
] as const

export const PASSTHROUGH_NAMES: readonly string[] = [
  ..."abcdefghijklmnopqrstuvwxyz".split(""),
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
  ..."0123456789".split(""),
  ..." `~!@#$%^&*()-_=+[]{}\\|;:'\",.<>/?".split(""),
  "return",
  "enter",
  "space",
  "tab",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "escape",
  "insert",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
]
