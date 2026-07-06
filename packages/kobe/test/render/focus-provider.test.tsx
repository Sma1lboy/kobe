import { describe, expect, it } from "bun:test"
import { FocusProvider, useFocus } from "../../src/tui/context/focus"
import { renderComponent } from "./harness"

function Probe() {
  const focus = useFocus()
  return (
    <box flexDirection="column">
      <text>{`focused:${focus.focused()}`}</text>
      <text>{`sidebar:${focus.is("sidebar")()}`}</text>
      <text>{`workspace:${focus.is("workspace")()}`}</text>
    </box>
  )
}

describe("FocusProvider", () => {
  it("defaults to the sidebar pane", async () => {
    const { frame } = await renderComponent(() => (
      <FocusProvider>
        <Probe />
      </FocusProvider>
    ))
    const text = await frame()
    expect(text).toContain("focused:sidebar")
    expect(text).toContain("sidebar:true")
    expect(text).toContain("workspace:false")
  })

  it("honors an explicit `initial` pane", async () => {
    const { frame } = await renderComponent(() => (
      <FocusProvider initial="terminal">
        <Probe />
      </FocusProvider>
    ))
    expect(await frame()).toContain("focused:terminal")
  })

  it("setFocused moves focus and cycle wraps through PANE_ORDER", async () => {
    let cycleFn: ((delta: 1 | -1) => void) | undefined
    let setFocusedFn: ((pane: "sidebar" | "workspace" | "files" | "terminal") => void) | undefined
    function Driver() {
      const focus = useFocus()
      cycleFn = focus.cycle
      setFocusedFn = focus.setFocused
      return <text>{`focused:${focus.focused()}`}</text>
    }
    const { frame } = await renderComponent(() => (
      <FocusProvider>
        <Driver />
      </FocusProvider>
    ))
    expect(await frame()).toContain("focused:sidebar")

    setFocusedFn?.("files")
    expect(await frame()).toContain("focused:files")

    cycleFn?.(1)
    expect(await frame()).toContain("focused:terminal")

    cycleFn?.(1)
    expect(await frame()).toContain("focused:sidebar")
  })
})
