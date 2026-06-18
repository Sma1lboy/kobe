// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DesktopWindowControls } from "../src/components/DesktopWindowControls.tsx"

describe("DesktopWindowControls", () => {
  afterEach(() => {
    delete document.documentElement.dataset.kobeDesktop
    delete window.kobeDesktopWindow
    cleanup()
  })

  it("is hidden in browser mode", () => {
    render(<DesktopWindowControls />)
    expect(screen.queryByLabelText("Window controls")).toBeNull()
  })

  it("renders desktop controls and sends window actions", () => {
    document.documentElement.dataset.kobeDesktop = "true"
    window.kobeDesktopWindow = {
      close: vi.fn(),
      minimize: vi.fn(),
      toggleMaximize: vi.fn(),
    }

    render(<DesktopWindowControls />)
    fireEvent.click(screen.getByLabelText("Close window"))
    fireEvent.click(screen.getByLabelText("Minimize window"))
    fireEvent.click(screen.getByLabelText("Zoom window"))

    expect(window.kobeDesktopWindow.close).toHaveBeenCalledOnce()
    expect(window.kobeDesktopWindow.minimize).toHaveBeenCalledOnce()
    expect(window.kobeDesktopWindow.toggleMaximize).toHaveBeenCalledOnce()
  })
})
