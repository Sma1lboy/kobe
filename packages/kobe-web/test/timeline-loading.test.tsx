// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { TimelinePanel } from "../src/components/TimelinePanel.tsx"

const emptyModel = { sessionId: "", turns: [] }

describe("TimelinePanel loading", () => {
  afterEach(cleanup)

  it("animates the causal chain while session identity is pending", () => {
    render(
      <TimelinePanel
        model={emptyModel}
        loaded={false}
        error={null}
        engineLabel="Codex"
        bindingState="pending"
        onExpand={() => undefined}
      />,
    )

    expect(screen.getByRole("status").textContent).toContain("Waiting for the engine session id")
    expect(screen.getByTestId("trace-loading").querySelectorAll(".trace-loader > span")).toHaveLength(3)
  })

  it("keeps the same loading grammar while persisted events are read", () => {
    render(
      <TimelinePanel
        model={{ sessionId: "session-1", turns: [] }}
        loaded={false}
        error={null}
        engineLabel="Codex"
        bindingState="bound"
        onExpand={() => undefined}
      />,
    )

    expect(screen.getByRole("status").textContent).toContain("Reading engine events")
  })
})
