// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Toasts } from "../src/components/Toasts.tsx"
import { pushToast } from "../src/lib/toast.ts"

describe("Toasts", () => {
  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers()
    })
    vi.useRealTimers()
    cleanup()
  })

  it("announces errors assertively and notices politely", () => {
    vi.useFakeTimers()
    render(<Toasts />)

    act(() => {
      pushToast("error", "Rename failed: boom")
      pushToast("info", "Watching sandbox")
    })

    const alert = screen.getByRole("alert")
    expect(alert.textContent).toContain("Rename failed: boom")
    expect(alert.getAttribute("aria-live")).toBe("assertive")
    expect(alert.getAttribute("aria-atomic")).toBe("true")

    const status = screen.getByRole("status")
    expect(status.textContent).toContain("Watching sandbox")
    expect(status.getAttribute("aria-live")).toBe("polite")
    expect(status.getAttribute("aria-atomic")).toBe("true")
  })
})
