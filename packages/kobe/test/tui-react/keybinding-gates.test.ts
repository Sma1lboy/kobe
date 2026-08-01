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
  nextFocusedPane,
  settingsCloseKeysEnabled,
  workspacePagesClosed,
} from "../../src/tui-react/workspace/keybinding-gates"

const closed: WorkspacePageState = {
  dialogOpen: false,
  settingsOpen: false,
  worktreesOpen: false,
  updateOpen: false,
  kanbanOpen: false,
  automationsOpen: false,
  workItemsOpen: false,
}

describe("workspacePagesClosed", () => {
  test("true only when nothing is open", () => {
    expect(workspacePagesClosed(closed)).toBe(true)
  })

  test("an open dialog disables workspace bindings", () => {
    expect(workspacePagesClosed({ ...closed, dialogOpen: true })).toBe(false)
  })

  test.each(["settingsOpen", "worktreesOpen", "updateOpen", "kanbanOpen"] as const)(
    "an open %s page disables them too",
    (page) => {
      expect(workspacePagesClosed({ ...closed, [page]: true })).toBe(false)
    },
  )
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

describe("nextFocusedPane", () => {
  const withFiles = { filesVisible: true }
  const noFiles = { filesVisible: false }

  test("steps through all three panes when files is mounted", () => {
    expect(nextFocusedPane("sidebar", 1, withFiles)).toBe("workspace")
    expect(nextFocusedPane("workspace", 1, withFiles)).toBe("files")
    expect(nextFocusedPane("files", -1, withFiles)).toBe("workspace")
  })

  test("clamps at both ends rather than wrapping", () => {
    // Cursor semantics, owner call 2026-07-25: "previous" from the sidebar
    // must never jump to files.
    expect(nextFocusedPane("sidebar", -1, withFiles)).toBeNull()
    expect(nextFocusedPane("files", 1, withFiles)).toBeNull()
  })

  test("skips the files pane when it is not mounted", () => {
    // Zen, or any rail page — focusing an unmounted pane would strand the
    // cursor on nothing.
    expect(nextFocusedPane("workspace", 1, noFiles)).toBeNull()
    expect(nextFocusedPane("sidebar", 1, noFiles)).toBe("workspace")
  })

  test("rescues focus that was left on a pane which just vanished", () => {
    // Opening a rail page while focus sat on files: there is no index to step
    // from, so land on the nearest end instead of doing nothing forever.
    expect(nextFocusedPane("files", -1, noFiles)).toBe("sidebar")
    expect(nextFocusedPane("files", 1, noFiles)).toBe("workspace")
  })
})
