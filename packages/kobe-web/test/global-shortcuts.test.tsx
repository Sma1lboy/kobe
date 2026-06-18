// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GlobalShortcuts } from "../src/components/GlobalShortcuts.tsx"
import {
  closeCommandPalette,
  closeKeyboardHelp,
  closeNewTask,
  closeSettings,
} from "../src/lib/global-ui.ts"

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}))

class EventSourceStub extends EventTarget {
  url: string

  constructor(url: string) {
    super()
    this.url = url
  }

  close(): void {}
}

describe("GlobalShortcuts", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", EventSourceStub)
  })

  afterEach(() => {
    act(() => {
      closeCommandPalette()
      closeKeyboardHelp()
      closeNewTask()
      closeSettings()
    })
    vi.unstubAllGlobals()
    cleanup()
  })

  it("opens keyboard help from the root key listener", () => {
    render(<GlobalShortcuts />)

    const event = new KeyboardEvent("keydown", {
      key: "?",
      bubbles: true,
      cancelable: true,
    })
    act(() => window.dispatchEvent(event))

    expect(event.defaultPrevented).toBe(true)
    expect(
      screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeTruthy()
  })

  it("suppresses the help shortcut while typing", () => {
    render(
      <>
        <input aria-label="filter" />
        <GlobalShortcuts />
      </>,
    )
    const input = screen.getByLabelText("filter")

    const event = new KeyboardEvent("keydown", {
      key: "?",
      bubbles: true,
      cancelable: true,
    })
    act(() => input.dispatchEvent(event))

    expect(event.defaultPrevented).toBe(false)
    expect(
      screen.queryByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeNull()
  })

  it("opens the command palette from the root key listener", () => {
    render(<GlobalShortcuts />)

    const event = new KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => window.dispatchEvent(event))

    expect(event.defaultPrevented).toBe(true)
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy()
  })
})
