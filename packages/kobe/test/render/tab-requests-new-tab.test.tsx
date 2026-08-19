/** @jsxImportSource @opentui/react */
/**
 * The sidebar menu's "New conversation" / "New shell" as the TASK's workspace
 * sees it: `requestNewTab` → the mounted `useTabRequests` listener.
 *
 * The risky halves are the two the sidebar can't see — that a request aimed at
 * a task whose tabs are NOT mounted survives until they are (the sidebar
 * activates the task, so the tabs always mount a beat later), and that "shell"
 * mints the same bare command tab the ctrl+e picker's shell pick does rather
 * than an engine tab.
 */

import { expect, test } from "bun:test"
import { requestNewTab } from "../../src/tui-react/workspace/terminal-tabs-shared"
import { useTabRequests } from "../../src/tui-react/workspace/use-tab-requests"
import { defaultShell } from "../../src/tui/panes/terminal/pty-types"
import { type TabsState, initialTabs } from "../../src/tui/workspace/terminal-tabs-core"
import { act, renderComponent, settle } from "./harness"

/** Task ids are unique per TEST on purpose: the harness tears the RENDERER down
 *  but does not unmount React, so a probe's listener outlives its test — one
 *  registered for a shared id would claim a later test's (or another file's)
 *  request and write into the wrong recorder. */
function harnessFor(taskId: string) {
  const writes: TabsState[] = []
  const chats: number[] = []
  const stateRef = { current: initialTabs() }
  const io = {
    stateRef,
    propsRef: { current: { taskId } },
    updateRef: {
      current: (next: TabsState) => {
        stateRef.current = next
        writes.push(next)
      },
    },
    tabCloseRef: { current: { closeById: () => {} } },
    activeLeafSizeRef: { current: () => null },
    requestNewChatRef: { current: () => chats.push(1) },
  }
  const Probe = () => {
    useTabRequests(io)
    return <text>probe</text>
  }
  return { Probe, writes, chats, stateRef }
}

test("'new conversation' opens the task's ctrl+e picker", async () => {
  const { Probe, chats, writes } = harnessFor("newtab-chat")
  await renderComponent(<Probe />, { width: 20, height: 4 })
  await settle()

  await act(async () => {
    requestNewTab("newtab-chat", "chat")
  })

  expect(chats.length).toBe(1)
  // The picker owns what lands — nothing is written before the user picks.
  expect(writes.length).toBe(0)
})

test("'new shell' mints a bare command tab, not an engine one", async () => {
  const { Probe, writes, chats } = harnessFor("newtab-shell")
  await renderComponent(<Probe />, { width: 20, height: 4 })
  await settle()

  await act(async () => {
    requestNewTab("newtab-shell", "shell")
  })

  expect(chats.length).toBe(0)
  const next = writes.at(-1)
  expect(next?.tabs.length).toBe(2)
  const added = next?.tabs.find((tab) => tab.id === next.activeId)
  expect(added?.kind).toBe("command")
  // Null title: the tab is named by its live foreground process.
  expect(added?.title).toBe(null)
  expect(added?.kind === "command" ? added.command : []).toEqual([defaultShell()])
})

test("a request for a task whose tabs aren't mounted waits for that mount", async () => {
  // What the sidebar actually does on a background worktree: ask, then let the
  // host's activation mount the workspace that claims it.
  const { Probe, chats } = harnessFor("newtab-cold")
  await act(async () => {
    requestNewTab("newtab-cold", "chat")
  })
  expect(chats.length).toBe(0)

  await renderComponent(<Probe />, { width: 20, height: 4 })
  await settle()

  expect(chats.length).toBe(1)
})

test("a request aimed at another task is left alone", async () => {
  const { Probe, chats, writes } = harnessFor("newtab-bystander")
  await renderComponent(<Probe />, { width: 20, height: 4 })
  await settle()

  await act(async () => {
    requestNewTab("newtab-other", "shell")
  })

  expect(chats.length).toBe(0)
  expect(writes.length).toBe(0)
  // Still pending: consumed by its own task's mount, whenever that happens.
  const other = harnessFor("newtab-other")
  await renderComponent(<other.Probe />, { width: 20, height: 4 })
  await settle()
  expect(other.writes.length).toBe(1)
})
