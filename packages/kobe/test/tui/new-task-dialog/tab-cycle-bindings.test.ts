import { type DialogTab, nextDialogTab, prevDialogTab } from "@/tui/component/new-task-dialog/state"
import { type RegisteredBinding, dispatchKeyEvent } from "@/tui/lib/keymap-dispatch"
import { describe, expect, test } from "vitest"

const ALL_TABS: readonly DialogTab[] = ["existing", "clone", "adopt"]

function tabCycleSlice(tab: DialogTab, switchToTab: (next: DialogTab) => void) {
  return [
    { key: "ctrl+]", cmd: () => switchToTab(nextDialogTab(tab)) },
    { key: "ctrl+[", cmd: () => switchToTab(prevDialogTab(tab)) },
  ]
}

function evt(name: string, ctrl = false) {
  let prevented = false
  return {
    name,
    ctrl,
    defaultPrevented: false,
    preventDefault() {
      prevented = true
    },
    get prevented() {
      return prevented
    },
  }
}

function stackFor(bindings: ReturnType<typeof tabCycleSlice>): RegisteredBinding[] {
  return [{ id: 1, config: () => ({ bindings }) }]
}

function press(from: DialogTab, keyName: string): DialogTab {
  let landed: DialogTab = from
  const switchToTab = (next: DialogTab): void => {
    landed = next
  }
  const hit = dispatchKeyEvent(stackFor(tabCycleSlice(from, switchToTab)), evt(keyName, true))
  expect(hit).toBe(true)
  return landed
}

describe("new-task dialog tab-cycle chords", () => {
  test("Ctrl+] advances forward through every tab", () => {
    for (const tab of ALL_TABS) {
      expect(press(tab, "]")).toBe(nextDialogTab(tab))
    }
  })

  test("Ctrl+[ steps backward through every tab (the bug: it used to go forward)", () => {
    for (const tab of ALL_TABS) {
      expect(press(tab, "[")).toBe(prevDialogTab(tab))
    }
    expect(press("existing", "[")).toBe("adopt")
  })

  test("Ctrl+] and Ctrl+[ are inverses on every tab", () => {
    for (const tab of ALL_TABS) {
      expect(press(press(tab, "]"), "[")).toBe(tab)
      expect(press(press(tab, "["), "]")).toBe(tab)
    }
  })
})
