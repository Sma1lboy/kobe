/**
 * `kobe doctor` terminal section — pure halves only (env formatting + kitty
 * probe reply parsing). Why this matters: keyboard bugs are terminal-
 * dependent (issue #192 — Terminal.app's legacy key path broke ctrl+h/j),
 * and doctor's terminal line is how a reporter tells us which key path
 * they're on. The live TTY probe is I/O-thin and untested by design.
 */

import { EventEmitter } from "node:events"
import { describe, expect, test, vi } from "vitest"
import { kittyProbeLine, parseKittyProbeReply, probeKittyKeyboard, terminalEnvLines } from "../../src/cli/doctor-terminal"

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

/**
 * The live probe, against a FAKE controlling terminal: process.stdin/stdout
 * are swapped for tty-shaped stand-ins (restored per test), so the raw-mode
 * dance, the reply decode, and the hard timeout are all exercised without a
 * real terminal. What matters: raw mode is always restored to what it was,
 * the listener is detached, and a mute terminal can never hang doctor.
 */
describe("probeKittyKeyboard (live probe against a fake tty)", () => {
  type FakeStdin = EventEmitter & {
    isTTY: boolean
    isRaw: boolean
    setRawMode: ReturnType<typeof vi.fn>
    resume: ReturnType<typeof vi.fn>
    pause: ReturnType<typeof vi.fn>
  }

  function fakeTty(opts: { wasRaw?: boolean } = {}) {
    const stdin = new EventEmitter() as FakeStdin
    stdin.isTTY = true
    stdin.isRaw = opts.wasRaw ?? false
    stdin.setRawMode = vi.fn((raw: boolean) => {
      stdin.isRaw = raw
      return stdin
    })
    stdin.resume = vi.fn()
    stdin.pause = vi.fn()
    const writes: string[] = []
    const stdout = {
      isTTY: true,
      write: (s: unknown) => {
        writes.push(String(s))
        return true
      },
    }
    return { stdin, stdout, writes }
  }

  async function withFakeTty<T>(
    tty: { stdin: unknown; stdout: unknown },
    run: () => Promise<T>,
  ): Promise<T> {
    const stdinDesc = Object.getOwnPropertyDescriptor(process, "stdin")
    const stdoutDesc = Object.getOwnPropertyDescriptor(process, "stdout")
    Object.defineProperty(process, "stdin", { value: tty.stdin, configurable: true })
    Object.defineProperty(process, "stdout", { value: tty.stdout, configurable: true })
    try {
      return await run()
    } finally {
      if (stdinDesc) Object.defineProperty(process, "stdin", stdinDesc)
      if (stdoutDesc) Object.defineProperty(process, "stdout", stdoutDesc)
    }
  }

  test("skips (with a reason) when not on an interactive terminal", async () => {
    const tty = fakeTty()
    ;(tty.stdin as FakeStdin).isTTY = false
    const result = await withFakeTty(tty, () => probeKittyKeyboard(50))
    expect(result).toEqual({ kind: "skipped", reason: "not an interactive terminal" })
    expect(tty.writes).toEqual([]) // never emits escape bytes into a pipe
  })

  test("a kitty flags reply resolves supported and restores non-raw mode", async () => {
    const tty = fakeTty()
    const result = await withFakeTty(tty, async () => {
      const probe = probeKittyKeyboard(1000)
      // The probe wrote its query + DA1 fence before listening for the reply.
      expect(tty.writes.join("")).toBe("\x1b[?u\x1b[c")
      // Reply arrives split across chunks — the decoder accumulates.
      tty.stdin.emit("data", Buffer.from("\x1b[?"))
      tty.stdin.emit("data", Buffer.from("5u"))
      return probe
    })
    expect(result).toEqual({ kind: "supported", flags: 5 })
    const stdin = tty.stdin as FakeStdin
    expect(stdin.setRawMode).toHaveBeenCalledWith(true)
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false) // restored — wasn't raw before
    expect(stdin.pause).toHaveBeenCalled()
    expect(stdin.listenerCount("data")).toBe(0) // listener detached
  })

  test("a DA1-only reply resolves unsupported; raw mode is LEFT ON when it was already on", async () => {
    const tty = fakeTty({ wasRaw: true })
    const result = await withFakeTty(tty, async () => {
      const probe = probeKittyKeyboard(1000)
      tty.stdin.emit("data", Buffer.from("\x1b[?62;22c"))
      return probe
    })
    expect(result).toEqual({ kind: "unsupported" })
    const stdin = tty.stdin as FakeStdin
    // The terminal was already raw (e.g. inside another TUI) — don't undo that.
    expect(stdin.setRawMode).not.toHaveBeenCalledWith(false)
  })

  test("a mute terminal times out to no-response instead of hanging doctor", async () => {
    const tty = fakeTty()
    const result = await withFakeTty(tty, () => probeKittyKeyboard(20))
    expect(result).toEqual({ kind: "no-response" })
    expect((tty.stdin as FakeStdin).pause).toHaveBeenCalled()
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
