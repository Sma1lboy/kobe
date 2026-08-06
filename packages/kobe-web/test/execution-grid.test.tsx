// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ExecutionGrid } from "../src/components/ExecutionGrid.tsx"
import type { TimelineItem } from "../src/lib/timeline.ts"

const commentary: TimelineItem = {
  id: "commentary-1",
  turnId: "turn-1",
  parentId: null,
  parentBasis: "none",
  kind: "commentary",
  status: "success",
  title: "I will inspect the focused test first.",
  summary: "",
  detail:
    "I will inspect the focused test first, then compare its fixture with the current protocol.",
  resultDetail: null,
  startedAt: 1_000,
  endedAt: 1_100,
}

const tool: TimelineItem = {
  id: "tool-1",
  turnId: "turn-1",
  parentId: commentary.id,
  parentBasis: "temporal",
  kind: "tool",
  status: "success",
  title: "exec",
  summary: "sed -n '1,120p' test.ts",
  detail: '{\n  "cmd": "sed -n \'1,120p\' test.ts"\n}',
  resultDetail: "The fixture still uses protocol version 1.",
  startedAt: 1_100,
  endedAt: 1_500,
}

describe("ExecutionGrid", () => {
  afterEach(cleanup)

  it("opens full commentary and tool details without overstating their relationship", () => {
    render(
      <ExecutionGrid
        items={[commentary, tool]}
        status="success"
        now={2_000}
      />,
    )

    fireEvent.click(
      screen.getByRole("button", { name: /Open Commentary details/ }),
    )
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(screen.getByText("Visible commentary")).toBeTruthy()
    expect(
      screen.getByText(
        "I will inspect the focused test first, then compare its fixture with the current protocol.",
      ),
    ).toBeTruthy()

    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByRole("dialog")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: /Open Tool details/ }))
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(screen.getByText("Observed after")).toBeTruthy()
    expect(screen.getByText("temporal link")).toBeTruthy()
    expect(screen.getByText("Input")).toBeTruthy()
    expect(screen.getByText("Result")).toBeTruthy()
    expect(
      screen.getByText("The fixture still uses protocol version 1."),
    ).toBeTruthy()
  })
})
