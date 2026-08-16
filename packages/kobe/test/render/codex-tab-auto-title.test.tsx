/** @jsxImportSource @opentui/react */
/**
 * Codex's unnamed OSC title is a session UUID, not a user-facing name. This
 * render test drives the real React effects that record that identity and
 * immediately resolve the first prompt, proving the visible title changes
 * without a keypress or the five-second fallback tick.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { useRef, useState } from "react"
import type { NotificationsContext } from "../../src/tui-react/context/notifications"
import { tabTitle } from "../../src/tui-react/workspace/tab-strip"
import type { TabsState } from "../../src/tui/workspace/terminal-tabs-core"
import { type RenderHandle, act, renderComponent, settle } from "./harness"

const SESSION_ID = "01a00808-9b77-7083-8f32-1f21b99e5eb3"
const PROMPT_TITLE = "让 Codex 标签立即显示可读标题"
const LIVE_TITLES = new Map([["tab-1", SESSION_ID]])
const LIVE_VENDORS = new Map([["tab-1", "codex" as const]])

// Keep the renderer real while replacing only the PTY poll boundary. The
// production hook still receives the same maps an OSC title push produces.
mock.module("../../src/tui-react/workspace/use-turn-polls", () => ({
  useTurnPolls: () => ({
    turnStates: new Map(),
    liveTitles: LIVE_TITLES,
    rawTitles: LIVE_TITLES,
    turnVendors: LIVE_VENDORS,
  }),
}))

const [{ useTabNaming }, { useTabTurnState }] = await Promise.all([
  import("../../src/tui-react/workspace/use-tab-lifecycle"),
  import("../../src/tui-react/workspace/use-tab-turn-state"),
])

const notifications: NotificationsContext = {
  toasts: [],
  unread: new Map(),
  notify: () => {},
  dismiss: () => {},
  markRead: () => {},
}

let codexHome: string
let sessionsDir: string
let previousCodexHome: string | undefined

beforeAll(() => {
  previousCodexHome = process.env.CODEX_HOME
  codexHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rove-codex-title-render-")))
  process.env.CODEX_HOME = codexHome
  sessionsDir = path.join(codexHome, "sessions", "2026", "08", "16")
  fs.mkdirSync(sessionsDir, { recursive: true })
})

function writeRollout(): void {
  const rollout = [
    { type: "session_meta", payload: { id: SESSION_ID, cwd: "/tmp/worktree" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: PROMPT_TITLE }],
      },
    },
  ]
  fs.writeFileSync(
    path.join(sessionsDir, `rollout-2026-08-16T00-00-00-${SESSION_ID}.jsonl`),
    `${rollout.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  )
}

afterAll(() => {
  if (previousCodexHome === undefined) Reflect.deleteProperty(process.env, "CODEX_HOME")
  else process.env.CODEX_HOME = previousCodexHome
  fs.rmSync(codexHome, { recursive: true, force: true })
  mock.restore()
})

const initialState = (): TabsState => ({
  tabs: [{ kind: "engine", id: "tab-1", title: null, ordinal: 1, vendor: "codex" }],
  activeId: "tab-1",
  nextOrdinal: 2,
})

function Driver(props: { updates: TabsState[]; onTitle: () => void }) {
  const [state, setState] = useState(initialState)
  const stateRef = useRef(state)
  stateRef.current = state
  const propsRef = useRef({ vendor: "codex" as const })
  const update = (next: TabsState): void => {
    stateRef.current = next
    props.updates.push(next)
    setState(next)
    if (next.tabs[0]?.autoTitle === PROMPT_TITLE) props.onTitle()
  }

  useTabTurnState({
    taskId: "task-1",
    worktree: "/tmp/worktree",
    vendor: "codex",
    state,
    notif: notifications,
    update,
  })
  useTabNaming({ stateRef, propsRef, update })

  return <text>{tabTitle(state.tabs[0]!, "codex", LIVE_TITLES.get("tab-1"))}</text>
}

describe("Codex tab auto-title React chain", () => {
  test("records the UUID and renders the first prompt without a click or fallback tick", async () => {
    const updates: TabsState[] = []
    let resolveTitle: () => void = () => {}
    const titleObserved = new Promise<void>((resolve) => {
      resolveTitle = resolve
    })
    let handle: RenderHandle | undefined
    await act(async () => {
      handle = await renderComponent(<Driver updates={updates} onTitle={resolveTitle} />)
    })
    if (!handle) throw new Error("renderer did not mount")
    const mounted = handle
    await act(async () => {
      // The session id can precede the first rollout write. Land history
      // after mount and let the follow-up render resolve it without input.
      writeRollout()
      await titleObserved
      await settle(0)
    })
    let rendered = ""
    await act(async () => {
      rendered = await mounted.frame()
    })

    expect(updates.some((state) => state.tabs[0]?.kind === "engine" && state.tabs[0].sessionId === SESSION_ID)).toBe(
      true,
    )
    expect(updates.some((state) => state.tabs[0]?.autoTitle === PROMPT_TITLE)).toBe(true)
    expect(rendered).toContain(PROMPT_TITLE)
    expect(rendered).not.toContain(SESSION_ID)
  })
})
