/**
 * Unit tests for `TmuxProtocolParser`. Drives the parser with
 * hand-crafted byte streams that mimic what `tmux -CC` writes on its
 * stdout, then asserts the typed event stream. No real tmux involved
 * here — that's the behavior test's job.
 */

import { describe, expect, it } from "vitest"
import { type TmuxEvent, TmuxProtocolParser, decodeOctalPayload } from "../../src/tmux/protocol-parser.ts"

function feedAll(p: TmuxProtocolParser, chunks: readonly (string | Uint8Array)[]): TmuxEvent[] {
  const out: TmuxEvent[] = []
  for (const c of chunks) {
    out.push(...p.feed(c))
  }
  return out
}

describe("TmuxProtocolParser — response blocks", () => {
  it("emits one response event for a multi-line %begin/%end block", () => {
    const p = new TmuxProtocolParser()
    const events = feedAll(p, [
      "%begin 1700000000 7 0\n",
      "line one\n",
      "line two\n",
      "line three\n",
      "%end 1700000000 7 0\n",
    ])
    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev?.type).toBe("response")
    if (ev?.type === "response") {
      expect(ev.commandNumber).toBe(7)
      expect(ev.success).toBe(true)
      expect(ev.body).toEqual(["line one", "line two", "line three"])
      expect(ev.timestamp).toBe(1700000000)
      expect(ev.flags).toBe("0")
    }
  })

  it("emits a failed response event for a %error block, carrying the error body", () => {
    const p = new TmuxProtocolParser()
    const events = feedAll(p, ["%begin 1700000000 9 0\n", "no current client\n", "%error 1700000000 9 0\n"])
    expect(events).toHaveLength(1)
    const ev = events[0]
    if (ev?.type === "response") {
      expect(ev.success).toBe(false)
      expect(ev.commandNumber).toBe(9)
      expect(ev.body).toEqual(["no current client"])
    } else {
      throw new Error("expected response event")
    }
  })

  it("treats notification-shaped lines inside a block as body lines, not notifications", () => {
    const p = new TmuxProtocolParser()
    const events = feedAll(p, [
      "%begin 1700000000 11 0\n",
      "%output %1 hello world\n",
      "%layout-change @1 foo bar baz\n",
      "%end 1700000000 11 0\n",
    ])
    expect(events).toHaveLength(1)
    const ev = events[0]
    if (ev?.type === "response") {
      expect(ev.body).toEqual(["%output %1 hello world", "%layout-change @1 foo bar baz"])
    } else {
      throw new Error("expected response event")
    }
  })

  it("buffers a chunk boundary in the middle of a line", () => {
    const p = new TmuxProtocolParser()
    const part1 = p.feed("%begi")
    const part2 = p.feed("n 1700000000 4 0\nhello\n%end 1700000000 4 0\n")
    expect(part1).toEqual([])
    expect(part2).toHaveLength(1)
    const ev = part2[0]
    if (ev?.type === "response") {
      expect(ev.commandNumber).toBe(4)
      expect(ev.body).toEqual(["hello"])
    } else {
      throw new Error("expected response event")
    }
  })
})

describe("TmuxProtocolParser — notifications", () => {
  it("emits typed events for notifications outside a block", () => {
    const p = new TmuxProtocolParser()
    const events = feedAll(p, [
      "%window-add @5\n",
      "%window-close @3\n",
      "%window-renamed @5 some long name with spaces\n",
      "%session-renamed brand new session name\n",
      "%sessions-changed\n",
      "%client-detached client-1\n",
    ])
    expect(events.map((e) => e.type)).toEqual([
      "window-add",
      "window-close",
      "window-renamed",
      "session-renamed",
      "sessions-changed",
      "client-detached",
    ])
    const renamed = events[2]
    if (renamed?.type === "window-renamed") {
      expect(renamed.windowId).toBe("@5")
      expect(renamed.name).toBe("some long name with spaces")
    }
    const sessionRenamed = events[3]
    if (sessionRenamed?.type === "session-renamed") {
      expect(sessionRenamed.name).toBe("brand new session name")
    }
  })

  it("emits a typed layout-change event", () => {
    const p = new TmuxProtocolParser()
    const events = feedAll(p, ["%layout-change @1 abcd,80x24,0,0,0 abcd,80x24,0,0,0 0\n"])
    expect(events).toHaveLength(1)
    const ev = events[0]
    if (ev?.type === "layout-change") {
      expect(ev.windowId).toBe("@1")
      expect(ev.layout).toBe("abcd,80x24,0,0,0")
      expect(ev.visibleLayout).toBe("abcd,80x24,0,0,0")
      expect(ev.flags).toBe("0")
    } else {
      throw new Error("expected layout-change event")
    }
  })

  it("emits %exit with no reason and with a free-form reason", () => {
    const p = new TmuxProtocolParser()
    const ev1 = p.feed("%exit\n")[0]
    const ev2 = p.feed("%exit server exited unexpectedly\n")[0]
    if (ev1?.type === "exit") expect(ev1.reason).toBe(null)
    else throw new Error("expected exit event")
    if (ev2?.type === "exit") expect(ev2.reason).toBe("server exited unexpectedly")
    else throw new Error("expected exit event")
  })

  it("emits an unknown event for any %foo line it doesn't recognise", () => {
    const p = new TmuxProtocolParser()
    const events = feedAll(p, ["%future-thing one two three\n"])
    expect(events).toHaveLength(1)
    const ev = events[0]
    if (ev?.type === "unknown") {
      expect(ev.line).toBe("%future-thing one two three")
    } else {
      throw new Error("expected unknown event")
    }
  })
})

describe("TmuxProtocolParser — output decoding", () => {
  it("decodes octal-escaped %output bytes back to the original Uint8Array", () => {
    const p = new TmuxProtocolParser()
    const events = feedAll(p, ["%output %2 hello\\040world\\033[31mred\\033[0m\\\\done\n"])
    expect(events).toHaveLength(1)
    const ev = events[0]
    if (ev?.type === "output") {
      expect(ev.paneId).toBe("%2")
      const expected = new TextEncoder().encode("hello world[31mred[0m\\done")
      expect(Array.from(ev.data)).toEqual(Array.from(expected))
    } else {
      throw new Error("expected output event")
    }
  })

  it("decodes %extended-output with age and the ` : ` separator", () => {
    const p = new TmuxProtocolParser()
    const events = feedAll(p, ["%extended-output %4 123 : hi\\012there\n"])
    expect(events).toHaveLength(1)
    const ev = events[0]
    if (ev?.type === "extended-output") {
      expect(ev.paneId).toBe("%4")
      expect(ev.age).toBe(123)
      expect(Array.from(ev.data)).toEqual([0x68, 0x69, 0x0a, 0x74, 0x68, 0x65, 0x72, 0x65])
    } else {
      throw new Error("expected extended-output event")
    }
  })

  it("decodeOctalPayload handles backslash-backslash and three-digit octal escapes", () => {
    expect(Array.from(decodeOctalPayload("\\\\"))).toEqual([0x5c])
    expect(Array.from(decodeOctalPayload("\\033"))).toEqual([0x1b])
    expect(Array.from(decodeOctalPayload("AB\\012"))).toEqual([0x41, 0x42, 0x0a])
  })
})

describe("TmuxProtocolParser — feed shape", () => {
  it("accepts Buffer/Uint8Array chunks and preserves bytes 0-255 through the string boundary", () => {
    const p = new TmuxProtocolParser()
    const line = Buffer.from("%output %1 a\\200b\n", "binary")
    const events = p.feed(line)
    expect(events).toHaveLength(1)
    const ev = events[0]
    if (ev?.type === "output") {
      expect(Array.from(ev.data)).toEqual([0x61, 0x80, 0x62])
    } else {
      throw new Error("expected output event")
    }
  })

  it("invokes the visitor when set, in addition to returning events from feed()", () => {
    const p = new TmuxProtocolParser()
    const seen: TmuxEvent[] = []
    p.setVisitor((ev) => seen.push(ev))
    const returned = p.feed("%sessions-changed\n%window-add @9\n")
    expect(returned.map((e) => e.type)).toEqual(["sessions-changed", "window-add"])
    expect(seen.map((e) => e.type)).toEqual(["sessions-changed", "window-add"])
  })
})
