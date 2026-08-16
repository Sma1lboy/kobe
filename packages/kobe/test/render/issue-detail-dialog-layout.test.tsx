/** @jsxImportSource @opentui/react */
/**
 * Story-drawer chip geometry. Some terminal fonts paint below the label's
 * cell, so the engine choices keep one empty interior row before the lower
 * border. Without that breathing room, the label appears to fall through the
 * chip even though the character grid itself is valid.
 */

import { expect, test } from "bun:test"
import { IssueDetailDialogView } from "../../src/tui-react/component/issue-detail-dialog"
import { renderComponent } from "./harness"

test("engine choices keep a breathing row between their labels and lower borders", async () => {
  const { frame } = await renderComponent(
    <IssueDetailDialogView
      issue={{ id: 1, title: "", status: "open", created: "2026-08-15", body: "" }}
      mode="create"
      engines={["claude", "codex", "copilot"]}
      defaultVendor="copilot"
      engineLabel={(vendor) =>
        vendor === "claude" ? "Claude" : vendor === "codex" ? "Codex" : vendor === "copilot" ? "Copilot" : vendor
      }
      onSubmit={() => {}}
      onCancel={() => {}}
    />,
    { width: 120, height: 60, providers: { dialog: true } },
  )

  const rows = (await frame()).split("\n")
  const labelRow = rows.findIndex((row) => row.includes("Claude") && row.includes("Codex") && row.includes("Copilot"))
  expect(labelRow).toBeGreaterThan(0)
  expect(rows[labelRow - 1]).toContain("┌")
  expect(rows[labelRow + 1]).toContain("│")
  expect(rows[labelRow + 1]).not.toContain("└")
  expect(rows[labelRow + 2]).toContain("└")
})
