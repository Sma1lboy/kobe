// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import {
  closeCommandPalette,
  closeKeyboardHelp,
  closeNewTask,
  closeSettings,
  openCommandPalette,
  openKeyboardHelp,
  openNewTask,
  openSettings,
  toggleCommandPalette,
  useGlobalUiState,
} from "../src/lib/global-ui.ts"

function Probe() {
  const state = useGlobalUiState()
  return (
    <output
      data-testid="global-ui"
      data-palette={String(state.paletteOpen)}
      data-help={String(state.helpOpen)}
      data-new-task={String(state.newTaskOpen)}
      data-settings={String(state.settingsOpen)}
    />
  )
}

describe("global-ui", () => {
  afterEach(() => {
    act(() => {
      closeCommandPalette()
      closeKeyboardHelp()
      closeNewTask()
      closeSettings()
    })
    cleanup()
  })

  it("keeps root-level overlay state in one shared store", () => {
    render(<Probe />)

    act(() => {
      openCommandPalette()
      openKeyboardHelp()
      openNewTask()
      openSettings()
    })

    const probe = screen.getByTestId("global-ui")
    expect(probe.getAttribute("data-palette")).toBe("true")
    expect(probe.getAttribute("data-help")).toBe("true")
    expect(probe.getAttribute("data-new-task")).toBe("true")
    expect(probe.getAttribute("data-settings")).toBe("true")
  })

  it("toggles the command palette independently", () => {
    render(<Probe />)

    act(() => toggleCommandPalette())
    expect(screen.getByTestId("global-ui").getAttribute("data-palette")).toBe(
      "true",
    )

    act(() => toggleCommandPalette())
    expect(screen.getByTestId("global-ui").getAttribute("data-palette")).toBe(
      "false",
    )
  })
})
