/**
 * Pins the workspace-host gating contract (workspace/keybinding-gates.ts):
 * an open dialog or full-page swap disables every workspace chord group,
 * and the ONE deliberate exemption — the settings page's own close keys —
 * is live exactly while settings is open with no sub-dialog above it.
 * Previously these were inline `dialog.stack.length === 0 && …` expressions
 * in host-keybindings.ts with no test.
 */

import { describe, expect, test } from "vitest"
import {
  type WorkspacePageState,
  bindingModeForPane,
  focusSlotIndex,
  settingsCloseKeysEnabled,
  workspacePagesClosed,
} from "../../src/tui-react/workspace/keybinding-gates"

const closed: WorkspacePageState = {
  dialogOpen: false,
  settingsOpen: false,
  worktreesOpen: false,
  updateOpen: false,
}

describe("workspacePagesClosed", () => {
  test("true only when nothing is open", () => {
    expect(workspacePagesClosed(closed)).toBe(true)
  })

  test("an open dialog disables workspace bindings", () => {
    expect(workspacePagesClosed({ ...closed, dialogOpen: true })).toBe(false)
  })

  test.each(["settingsOpen", "worktreesOpen", "updateOpen"] as const)("an open %s page disables them too", (page) => {
    expect(workspacePagesClosed({ ...closed, [page]: true })).toBe(false)
  })
})

describe("settingsCloseKeysEnabled — the deliberate exemption", () => {
  test("live while the settings page is open (workspace chords are NOT)", () => {
    const state = { ...closed, settingsOpen: true }
    expect(settingsCloseKeysEnabled(state)).toBe(true)
    expect(workspacePagesClosed(state)).toBe(false)
  })

  test("yields to a sub-dialog above the settings page (esc/typing stay with the dialog)", () => {
    expect(settingsCloseKeysEnabled({ ...closed, settingsOpen: true, dialogOpen: true })).toBe(false)
  })

  test("dead while settings is closed", () => {
    expect(settingsCloseKeysEnabled(closed)).toBe(false)
    expect(settingsCloseKeysEnabled({ ...closed, worktreesOpen: true })).toBe(false)
  })
})

describe("bindingModeForPane", () => {
  test("keeps ChatPane and terminal-conflicting controls behind the prefix", () => {
    expect(bindingModeForPane("workspace")).toBe("prefix")
    expect(bindingModeForPane("terminal")).toBe("prefix")
  })

  test("restores direct Ctrl controls in Tasks and Files panes", () => {
    expect(bindingModeForPane("sidebar")).toBe("direct")
    expect(bindingModeForPane("files")).toBe("direct")
  })
})

describe("focusSlotIndex", () => {
  test("normalizes the prefix half of a dual-mode four-pane binding", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(focusSlotIndex)).toEqual([0, 1, 2, 3, 0, 1, 2, 3])
  })
})
