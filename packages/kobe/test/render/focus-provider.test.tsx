/** @jsxImportSource @opentui/react */
/**
 * FocusProvider — pane focus context (src/tui-react/context/focus.tsx). Imports
 * @opentui/react (useRenderer) so it can't run under vitest at all; this is its
 * only coverage. Drives the real `focused`/`is`/`cycle`/`setFocused` surface
 * every pane wrapper reads. API delta from Solid: `focused`/`is()` are plain
 * values, not accessors.
 */
import { describe, expect, it } from "bun:test"
import { FocusProvider, type PaneId, useFocus } from "../../src/tui-react/context/focus"
import { act, renderComponent } from "./harness"

function Probe() {
  const focus = useFocus()
  return (
    <box flexDirection="column">
      <text>{`focused:${focus.focused}`}</text>
      <text>{`sidebar:${focus.is("sidebar")}`}</text>
      <text>{`workspace:${focus.is("workspace")}`}</text>
    </box>
  )
}

describe("FocusProvider", () => {
  it("defaults to the sidebar pane", async () => {
    const { frame } = await renderComponent(
      <FocusProvider>
        <Probe />
      </FocusProvider>,
    )
    const text = await frame()
    expect(text).toContain("focused:sidebar")
    expect(text).toContain("sidebar:true")
    expect(text).toContain("workspace:false")
  })

  it("honors an explicit `initial` pane", async () => {
    const { frame } = await renderComponent(
      <FocusProvider initial="terminal">
        <Probe />
      </FocusProvider>,
    )
    expect(await frame()).toContain("focused:terminal")
  })

  it("setFocused moves focus and cycle wraps through PANE_ORDER", async () => {
    let cycleFn: ((delta: 1 | -1) => void) | undefined
    let setFocusedFn: ((pane: PaneId) => void) | undefined
    function Driver() {
      const focus = useFocus()
      cycleFn = focus.cycle
      setFocusedFn = focus.setFocused
      return <text>{`focused:${focus.focused}`}</text>
    }
    const { frame } = await renderComponent(
      <FocusProvider>
        <Driver />
      </FocusProvider>,
    )
    expect(await frame()).toContain("focused:sidebar")

    act(() => setFocusedFn?.("files"))
    expect(await frame()).toContain("focused:files")

    act(() => cycleFn?.(1)) // files -> terminal (PANE_ORDER: sidebar, workspace, files, terminal)
    expect(await frame()).toContain("focused:terminal")

    act(() => cycleFn?.(1)) // terminal wraps back to sidebar
    expect(await frame()).toContain("focused:sidebar")
  })
})
