/** @jsxImportSource @opentui/react */
/**
 * Terminal pane IME/CJK forwarding — end-to-end render test (KOB-208
 * regression guard, carried across the Solid→React migration).
 *
 * The invariant KOB-208 established and this locks in: a keypress the kobe
 * keymap did NOT consume (CJK / pinyin IME commits, whose opentui `name` is
 * the composed character and match no chord) must reach the focused
 * terminal's PTY verbatim via `sequence`, while a RESERVED_GLOBAL_CHORD
 * (ctrl+q — the escape hatch) must be consumed by the global keymap and NOT
 * forwarded to the shell. Drives the REAL @opentui/react renderer + real
 * StdinParser (mockInput.typeText emits raw UTF-8 bytes), so it exercises the
 * exact 0.4.x parse → dispatch → catch-all path the shipped React TUI runs.
 */
import { describe, expect, it } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import { useBindings } from "../../src/tui-react/lib/keymap"
import { useTerminalBindings } from "../../src/tui-react/panes/terminal/keys"
import { renderComponent, settle } from "./harness"

function Probe(opts: { writes: string[]; globalHits: string[]; focused: boolean }) {
  // A global keymap binding that owns ctrl+q (the workspace→sidebar escape),
  // registered like the real host so the terminal leaves it reserved.
  useBindings(() => ({
    enabled: true,
    bindings: [{ key: "ctrl+q", cmd: () => opts.globalHits.push("ctrl+q") }],
  }))
  useTerminalBindings({
    focused: opts.focused,
    write: (d: string) => opts.writes.push(d),
    paste: () => {},
    scroll: () => {},
    reset: () => {},
  })
  return <box />
}

describe("terminal pane — CJK/IME passthrough (KOB-208)", () => {
  it("forwards a composed CJK char to the PTY and never fires a chord", async () => {
    const writes: string[] = []
    const globalHits: string[] = []
    const { mockInput } = await renderComponent(<Probe writes={writes} globalHits={globalHits} focused />)
    await mockInput.typeText("你")
    await settle()
    expect(writes).toContain("你")
    expect(globalHits).toHaveLength(0)
  })

  it("still lets ctrl+q escape (consumed by the global keymap, not forwarded)", async () => {
    const writes: string[] = []
    const globalHits: string[] = []
    const { mockInput } = await renderComponent(<Probe writes={writes} globalHits={globalHits} focused />)
    mockInput.pressKey("q", { ctrl: true })
    await settle()
    expect(globalHits).toContain("ctrl+q")
    // ctrl+q must NOT reach the shell as XON (\x11).
    expect(writes.join("")).not.toContain("\x11")
  })

  it("forwards printable ASCII to the PTY", async () => {
    const writes: string[] = []
    const globalHits: string[] = []
    const { mockInput } = await renderComponent(<Probe writes={writes} globalHits={globalHits} focused />)
    await mockInput.typeText("n")
    await settle()
    expect(writes).toContain("n")
  })

  it("does NOT forward when the pane is unfocused (dialog open / other pane)", async () => {
    const writes: string[] = []
    const globalHits: string[] = []
    const { mockInput } = await renderComponent(<Probe writes={writes} globalHits={globalHits} focused={false} />)
    await mockInput.typeText("你")
    await settle()
    expect(writes).toHaveLength(0)
  })
})
