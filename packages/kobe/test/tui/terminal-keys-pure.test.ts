import type { KeyEvent } from "@opentui/core"
import { describe, expect, it } from "vitest"
import { defaultChordsOf, findBinding, resetKeymapToDefaults } from "../../src/tui/context/keybindings"
import {
  DEFAULT_PAGE_SIZE,
  PASSTHROUGH_NAMES,
  RESERVED_GLOBAL_CHORDS,
  TRAPPED_KEYS,
  keyEventToShellBytes,
} from "../../src/tui/panes/terminal/keys-pure"

function evt(partial: Partial<KeyEvent> & { name: string }): KeyEvent {
  return partial as unknown as KeyEvent
}

describe("keyEventToShellBytes", () => {
  it("forwards the upstream byte sequence verbatim when present", () => {
    expect(keyEventToShellBytes(evt({ name: "a", sequence: "\x1b[Z" } as never))).toBe("\x1b[Z")
  })

  it("synthesizes the named-key sequences tests and mocks rely on", () => {
    expect(keyEventToShellBytes(evt({ name: "return" }))).toBe("\r")
    expect(keyEventToShellBytes(evt({ name: "enter" }))).toBe("\r")
    expect(keyEventToShellBytes(evt({ name: "tab" }))).toBe("\t")
    expect(keyEventToShellBytes(evt({ name: "backspace" }))).toBe("\x7f")
    expect(keyEventToShellBytes(evt({ name: "delete" }))).toBe("\x1b[3~")
    expect(keyEventToShellBytes(evt({ name: "up" }))).toBe("\x1b[A")
    expect(keyEventToShellBytes(evt({ name: "escape" }))).toBe("\x1b")
    expect(keyEventToShellBytes(evt({ name: "space" }))).toBe(" ")
  })

  it("maps ctrl+letter to C0 control bytes; plain letters pass through", () => {
    expect(keyEventToShellBytes(evt({ name: "c", ctrl: true }))).toBe("\x03")
    expect(keyEventToShellBytes(evt({ name: "Z", ctrl: true }))).toBe("\x1a")
    expect(keyEventToShellBytes(evt({ name: "q" }))).toBe("q")
  })

  it("re-encodes kitty CSI-u keystrokes instead of trusting sequence", () => {
    // The host renderer runs with useKittyKeyboard, so on kitty-capable
    // terminals modifier chords arrive CSI-u encoded. Field shapes below
    // were measured on the real wire (Bun PTY probe, 2026-07-06): for
    // ctrl+c opentui puts the LOGICAL key ("c") in `sequence` — forwarding
    // it verbatim typed a literal "c" instead of interrupting — while for
    // esc `sequence` carries the raw CSI-u bytes.
    expect(keyEventToShellBytes(evt({ name: "c", ctrl: true, sequence: "c", raw: "\x1b[99;5u" } as never))).toBe("\x03")
    expect(keyEventToShellBytes(evt({ name: "escape", sequence: "\x1b[27u", raw: "\x1b[27u" } as never))).toBe("\x1b")
    expect(keyEventToShellBytes(evt({ name: "space", ctrl: true, sequence: " ", raw: "\x1b[32;5u" } as never))).toBe(
      "\x00",
    )
    expect(keyEventToShellBytes(evt({ name: "\\", ctrl: true, sequence: "\\", raw: "\x1b[92;5u" } as never))).toBe(
      "\x1c",
    )
    // A ctrl chord the synthesizer can't map is dropped — typing a stray
    // literal into the shell would be worse.
    expect(keyEventToShellBytes(evt({ name: "pageup", ctrl: true, sequence: "\x1b[57362;5u" } as never))).toBeNull()
    // Legacy bytes keep forwarding verbatim (raw == sequence, not CSI-u).
    expect(keyEventToShellBytes(evt({ name: "delete", sequence: "\x1b[3~", raw: "\x1b[3~" } as never))).toBe("\x1b[3~")
    expect(keyEventToShellBytes(evt({ name: "c", ctrl: true, sequence: "\x03", raw: "\x03" } as never))).toBe("\x03")
  })

  it("returns null for unknown multi-char names and nameless events", () => {
    expect(keyEventToShellBytes(evt({ name: "pageup" }))).toBeNull()
    expect(keyEventToShellBytes(evt({ name: "" }))).toBeNull()
  })
})

describe("key routing tables", () => {
  it("reserves ONLY the minimal kobe chords; the engine owns the rest", () => {
    expect(TRAPPED_KEYS).toEqual(["ctrl+pageup", "ctrl+pagedown"])
    // Owner decision 2026-07-06: ctrl+q escape hatch + tab management +
    // splits + reset, plus f4 (focus.next pane cycle — the one cross-pane
    // chord besides ctrl+q reachable from inside the terminal). Anything
    // beyond this list steals a chord from the engine CLI. f6 (issue #18,
    // workspace.zenToggle) added 2026-07-07 for the same reason as f4;
    // f7 (attention.next — jump to the next waiting task) same rationale.
    // NOT ctrl+g for attention.next: that's the engine's readline abort —
    // it moved to f7 so ctrl+g passes through to the engine again.
    expect([...RESERVED_GLOBAL_CHORDS].sort()).toEqual(
      [
        "ctrl+[",
        "ctrl+]",
        "ctrl+e",
        "ctrl+f",
        "ctrl+q",
        "ctrl+t",
        "ctrl+w",
        "ctrl+\\",
        "ctrl+=",
        "f2",
        "f3",
        "f4",
        "f5",
        "f6",
        "f7",
      ].sort(),
    )
    // Chords the engine depends on must NOT be reserved (shift+tab is
    // claude's plan-mode cycle; ctrl+g is readline abort-editing; the rest
    // are its own UI shortcuts).
    for (const chord of ["shift+tab", "ctrl+g", "ctrl+h", "ctrl+p", "f1", "ctrl+r"]) {
      expect(RESERVED_GLOBAL_CHORDS).not.toContain(chord)
    }
    // Plain typing keys must stay forwardable.
    for (const name of ["a", "Z", "0", " ", "return", "escape", "tab"]) {
      expect(PASSTHROUGH_NAMES).toContain(name)
    }
    expect(DEFAULT_PAGE_SIZE).toBeGreaterThan(0)
  })

  it("derives the reservation from KobeKeymap DEFAULTS, immune to live overrides", () => {
    // RESERVED_GLOBAL_CHORDS is generated from RESERVED_SPEC (keys-pure.ts):
    // ids resolve via defaultChordsOf, prefix-moved chords stay literals —
    // the exact-list pin above is what fails if a keymap-table edit
    // silently changes terminal passthrough. This case pins the other
    // half: user overrides must NOT change the reservation, matching the
    // old literal behavior.
    const row = findBinding("focus.next") as unknown as { keys: readonly string[] }
    expect(row.keys).toEqual(["f4"])
    row.keys = ["ctrl+x"]
    try {
      expect(defaultChordsOf("focus.next")).toEqual(["f4"])
      expect(RESERVED_GLOBAL_CHORDS).toContain("f4")
      expect(RESERVED_GLOBAL_CHORDS).not.toContain("ctrl+x")
    } finally {
      resetKeymapToDefaults()
    }
    expect(defaultChordsOf("nope.not-a-binding")).toEqual([])
  })

  it("synthesizes modifier bytes for synthetic events", () => {
    expect(keyEventToShellBytes(evt({ name: "tab", shift: true }))).toBe("\x1b[Z")
    expect(keyEventToShellBytes(evt({ name: "b", option: true } as never))).toBe("\x1bb")
  })
})
