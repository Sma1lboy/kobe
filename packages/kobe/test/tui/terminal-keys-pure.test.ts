/**
 * Why this matters: keyEventToShellBytes is every keystroke's path into the
 * embedded engine CLI — a wrong byte turns Enter into a literal, or a ctrl
 * chord into shell garbage. RESERVED_GLOBAL_CHORDS is the user's only way
 * OUT of the terminal pane; if a chord leaks from that list into the PTY
 * the user is trapped inside the engine (the KOB-208 class of bug).
 */

import type { KeyEvent } from "@opentui/core"
import { describe, expect, it } from "vitest"
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

  it("returns null for unknown multi-char names and nameless events", () => {
    expect(keyEventToShellBytes(evt({ name: "pageup" }))).toBeNull()
    expect(keyEventToShellBytes(evt({ name: "" }))).toBeNull()
  })
})

describe("key routing tables", () => {
  it("keeps every escape hatch reserved (first-match beats passthrough)", () => {
    expect(TRAPPED_KEYS).toEqual(["ctrl+pageup", "ctrl+pagedown"])
    // The primary escape hatches stay reserved — losing any of these traps
    // the user inside the engine CLI. (F-keys deliberately ALSO appear in
    // PASSTHROUGH_NAMES: reservation wins by binding order, not disjointness.)
    for (const chord of ["ctrl+h", "ctrl+j", "ctrl+k", "ctrl+l", "ctrl+q", "f1", "f5", "ctrl+p", "shift+tab"]) {
      expect(RESERVED_GLOBAL_CHORDS).toContain(chord)
    }
    // Plain typing keys must stay forwardable.
    for (const name of ["a", "Z", "0", " ", "return", "escape", "tab"]) {
      expect(PASSTHROUGH_NAMES).toContain(name)
    }
    expect(DEFAULT_PAGE_SIZE).toBeGreaterThan(0)
  })
})
