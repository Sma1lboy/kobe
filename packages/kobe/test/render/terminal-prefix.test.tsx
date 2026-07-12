/** @jsxImportSource @opentui/react */
/**
 * PureTUI prefix (#308) vs the focused terminal pane — end-to-end render
 * test of the contested routing question: with the terminal focused, does
 * the prefix first stroke (default `ctrl+a`) reach the app dispatcher, or
 * leak into the PTY as `\x01` (readline beginning-of-line)?
 *
 * The invariant this locks in: `dispatchKeyEvent` arms the prefix BEFORE
 * walking the binding stack, so the terminal's passthrough entry never
 * sees the first stroke, the second stroke fires the prefix action, and a
 * missed second stroke is consumed rather than typed into the shell. The
 * flip side is also pinned: without an armed prefix, the same letter still
 * forwards to the PTY verbatim.
 *
 * Drives the REAL @opentui/react renderer + StdinParser, same as
 * terminal-ime-keys.test.tsx (KOB-208).
 */
import { afterEach, describe, expect, it } from "bun:test"
import { bindByIds } from "../../src/tui-react/context/keybindings"
import { useBindings } from "../../src/tui-react/lib/keymap"
import { useTerminalBindings } from "../../src/tui-react/panes/terminal/keys"
import { configurePrefix, resetPrefixConfiguration } from "../../src/tui/lib/keymap-dispatch"
import { renderComponent, settle } from "./harness"

afterEach(() => {
  resetPrefixConfiguration()
})

function Probe(opts: { writes: string[]; actionHits: string[] }) {
  // A real prefix-carrying row, registered like the workspace host does:
  // `chat.fork.new` is prefix-only (`prefixKeys: ["f"]`), so bindByIds
  // emits a `{ key: "f", prefix: true }` dispatcher entry and makes the
  // prefix reachable.
  useBindings(() => ({
    enabled: true,
    bindings: bindByIds({ "chat.fork.new": () => opts.actionHits.push("chat.fork.new") }),
  }))
  useTerminalBindings({
    focused: true,
    write: (d: string) => opts.writes.push(d),
    paste: () => {},
    scroll: () => {},
    reset: () => {},
  })
  return <box />
}

describe("terminal pane — PureTUI prefix routing (#308)", () => {
  it("consumes the prefix first stroke instead of forwarding \\x01 to the PTY", async () => {
    const writes: string[] = []
    const actionHits: string[] = []
    const { mockInput } = await renderComponent(<Probe writes={writes} actionHits={actionHits} />)
    mockInput.pressKey("a", { ctrl: true })
    await settle()
    expect(writes.join("")).not.toContain("\x01")
    expect(actionHits).toHaveLength(0) // armed, nothing fired yet
  })

  it("fires the prefix action on the second stroke from inside the terminal", async () => {
    const writes: string[] = []
    const actionHits: string[] = []
    const { mockInput } = await renderComponent(<Probe writes={writes} actionHits={actionHits} />)
    mockInput.pressKey("a", { ctrl: true })
    await settle()
    await mockInput.typeText("f")
    await settle()
    expect(actionHits).toContain("chat.fork.new")
    // Neither stroke may leak into the shell.
    expect(writes.join("")).not.toContain("\x01")
    expect(writes).not.toContain("f")
  })

  it("still forwards the same letter to the PTY when no prefix is armed", async () => {
    const writes: string[] = []
    const actionHits: string[] = []
    const { mockInput } = await renderComponent(<Probe writes={writes} actionHits={actionHits} />)
    await mockInput.typeText("f")
    await settle()
    expect(writes).toContain("f")
    expect(actionHits).toHaveLength(0)
  })

  it("honors a reconfigured first stroke: ctrl+b arms, ctrl+a returns to the PTY", async () => {
    const writes: string[] = []
    const actionHits: string[] = []
    const { mockInput } = await renderComponent(<Probe writes={writes} actionHits={actionHits} />)
    configurePrefix({ key: "ctrl+b", timeoutMs: 1000 })
    // Old default now forwards to the shell as \x01 (readline home).
    mockInput.pressKey("a", { ctrl: true })
    await settle()
    expect(writes.join("")).toContain("\x01")
    // New key arms and completes the sequence.
    mockInput.pressKey("b", { ctrl: true })
    await settle()
    await mockInput.typeText("f")
    await settle()
    expect(actionHits).toContain("chat.fork.new")
    expect(writes.join("")).not.toContain("\x02")
  })

  it("consumes a missed second stroke instead of typing it into the shell", async () => {
    const writes: string[] = []
    const actionHits: string[] = []
    const { mockInput } = await renderComponent(<Probe writes={writes} actionHits={actionHits} />)
    mockInput.pressKey("a", { ctrl: true })
    await settle()
    await mockInput.typeText("z")
    await settle()
    expect(actionHits).toHaveLength(0)
    expect(writes).not.toContain("z")
  })
})
