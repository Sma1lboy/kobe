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

const change: TimelineItem = {
  ...tool,
  id: "change-1",
  parentId: null,
  parentBasis: "none",
  kind: "change",
  title: "apply_patch",
  detail: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch",
}

const retriedTool: TimelineItem = {
  ...tool,
  id: "tool-2",
  parentId: null,
  parentBasis: "none",
  retryOf: tool.id,
  attempt: 2,
}

const subagent: TimelineItem = {
  ...tool,
  id: "agent-7",
  parentId: null,
  parentBasis: "none",
  kind: "subagent",
  title: "reviewer",
  detail: "agent-7\n/tmp/subagent.jsonl",
  resultDetail: "Focused tests pass.",
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

  it("renders patch, explicit retry, and subagent completion details", () => {
    render(
      <ExecutionGrid
        items={[tool, change, retriedTool, subagent]}
        status="success"
        now={2_000}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /Open Change details/ }))
    expect(screen.getByText("Patch")).toBeTruthy()
    expect(screen.getByText("+new")).toBeTruthy()
    fireEvent.keyDown(window, { key: "Escape" })

    fireEvent.click(screen.getAllByRole("button", { name: /Open Tool details/ })[1]!)
    expect(screen.getByText("Engine-declared retry")).toBeTruthy()
    expect(screen.getByText("Retrying exec")).toBeTruthy()
    expect(screen.getByText("attempt 2")).toBeTruthy()
    fireEvent.keyDown(window, { key: "Escape" })

    fireEvent.click(screen.getByRole("button", { name: /Open Subagent details/ }))
    expect(screen.getByText("Subagent identity")).toBeTruthy()
    expect(screen.getByText("Subagent result")).toBeTruthy()
    expect(screen.getByText("Focused tests pass.")).toBeTruthy()
  })
})
