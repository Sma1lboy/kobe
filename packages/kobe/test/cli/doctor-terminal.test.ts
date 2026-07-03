/**
 * `kobe doctor` terminal section — pure halves only (env formatting + kitty
 * probe reply parsing). Why this matters: keyboard bugs are terminal-
 * dependent (issue #192 — Terminal.app's legacy key path broke ctrl+h/j),
 * and doctor's terminal line is how a reporter tells us which key path
 * they're on. The live TTY probe is I/O-thin and untested by design.
 */

import { describe, expect, test } from "vitest"
import { kittyProbeLine, parseKittyProbeReply, terminalEnvLines } from "../../src/cli/doctor-terminal"

describe("terminalEnvLines", () => {
  test("formats TERM / TERM_PROGRAM(+version) / COLORTERM and tmux nesting", () => {
    const lines = terminalEnvLines({
      TERM: "xterm-256color",
      TERM_PROGRAM: "Apple_Terminal",
      TERM_PROGRAM_VERSION: "453",
      COLORTERM: undefined,
      TMUX: "/tmp/tmux-501/kobe,123,0",
    })
    expect(lines[0]).toBe("terminal: TERM=xterm-256color  TERM_PROGRAM=Apple_Terminal v453  COLORTERM=(unset)")
    expect(lines[1]).toBe("          running inside tmux: yes")
  })

  test("everything unset stays readable", () => {
    const lines = terminalEnvLines({})
    expect(lines[0]).toBe("terminal: TERM=(unset)  TERM_PROGRAM=(unset)  COLORTERM=(unset)")
    expect(lines[1]).toBe("          running inside tmux: no")
  })
})

describe("parseKittyProbeReply", () => {
  test("kitty flags reply → supported with parsed flags", () => {
    expect(parseKittyProbeReply("\x1b[?1u")).toEqual({ kind: "supported", flags: 1 })
    expect(parseKittyProbeReply("\x1b[?31u\x1b[?62;c")).toEqual({ kind: "supported", flags: 31 })
  })

  test("DA1 reply without a kitty reply → unsupported (the fence answered first)", () => {
    expect(parseKittyProbeReply("\x1b[?62;22;52c")).toEqual({ kind: "unsupported" })
    expect(parseKittyProbeReply("\x1b[?1;2c")).toEqual({ kind: "unsupported" })
  })

  test("partial buffer → null (keep reading)", () => {
    expect(parseKittyProbeReply("")).toBeNull()
    expect(parseKittyProbeReply("\x1b[?6")).toBeNull()
  })
})

describe("kittyProbeLine", () => {
  test("one line per outcome, unsupported names the legacy-key consequence", () => {
    expect(kittyProbeLine({ kind: "supported", flags: 1 })).toContain("✓ answered (flags=1)")
    expect(kittyProbeLine({ kind: "unsupported" })).toContain("legacy key path")
    expect(kittyProbeLine({ kind: "no-response" })).toContain("no reply")
    expect(kittyProbeLine({ kind: "skipped", reason: "not an interactive terminal" })).toContain(
      "skipped (not an interactive terminal)",
    )
  })
})
