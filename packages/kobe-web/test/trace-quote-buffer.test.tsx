// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TraceQuoteBuffer } from "../src/components/TraceQuoteBuffer.tsx"
import { isBufferedSubmitKey } from "../src/lib/trace-quote-buffer.ts"

const quote = {
  sourceId: "tool-1",
  label: "Tool · exec",
  text: "[Quoted Agent Trace block]",
}

describe("TraceQuoteBuffer", () => {
  afterEach(cleanup)

  it("renders a removable structured quote", () => {
    const onRemove = vi.fn()
    render(<TraceQuoteBuffer quotes={[quote]} onRemove={onRemove} />)

    expect(screen.getByText("Tool · exec")).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove quoted block: Tool · exec",
      }),
    )
    expect(onRemove).toHaveBeenCalledWith("tool-1")
  })

  it("intercepts only plain Enter for buffered submission", () => {
    expect(isBufferedSubmitKey({ key: "Enter" })).toBe(true)
    expect(isBufferedSubmitKey({ key: "Enter", shiftKey: true })).toBe(false)
    expect(isBufferedSubmitKey({ key: "Enter", isComposing: true })).toBe(false)
    expect(isBufferedSubmitKey({ key: "Backspace" })).toBe(false)
  })
})
