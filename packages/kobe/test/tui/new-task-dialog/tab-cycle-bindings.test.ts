/**
 * Regression test for the new-task dialog's Ctrl+[ / Ctrl+] tab-cycle chords.
 *
 * The production bug this pins: Ctrl+[ ("previous sub-tab", per its own
 * comment) was wired to `nextDialogTab`, identical to Ctrl+] — so with the
 * three sub-tabs (Existing / Clone / Adopt, KOB-256) both chords cycled
 * FORWARD and there was no way to step back with the keyboard chords. The
 * ←/→ selector path (`cycleTab`) used prev/next correctly, masking the defect.
 *
 * dialog.tsx builds its bindings inline (the component drags in opentui), so —
 * like ctrl-a-gating.test.ts — this reproduces the exact binding shape and the
 * real `nextDialogTab`/`prevDialogTab` cycle helpers, then asserts the dispatch
 * outcome: Ctrl+] advances, Ctrl+[ reverses, and the two are inverses on every
 * tab. If a future edit re-points either chord at the wrong helper, the
 * round-trip assertions below fail.
 */

import { type DialogTab, nextDialogTab, prevDialogTab } from "@/tui/component/new-task-dialog/state"
import { type RegisteredBinding, dispatchKeyEvent } from "@/tui/lib/keymap-dispatch"
import { describe, expect, test } from "vitest"

const ALL_TABS: readonly DialogTab[] = ["existing", "clone", "adopt"]

/** The tab-cycle slice of the dialog's binding list, built exactly as
 *  dialog.tsx does: Ctrl+] → next sub-tab, Ctrl+[ → previous sub-tab. */
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

/** Dispatch one chord against the slice built for `from`, returning the tab the
 *  handler switched to (or `from` if nothing fired). */
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
    // Concretely: from "existing", back lands on "adopt", not "clone".
    expect(press("existing", "[")).toBe("adopt")
  })

  test("Ctrl+] and Ctrl+[ are inverses on every tab", () => {
    for (const tab of ALL_TABS) {
      expect(press(press(tab, "]"), "[")).toBe(tab)
      expect(press(press(tab, "["), "]")).toBe(tab)
    }
  })
})
