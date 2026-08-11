/** @jsxImportSource @opentui/react */
/**
 * Unified new-conversation DISPATCH (issue #7) — the four toggle combos must
 * land in four different places, driven by REAL keypresses through the real
 * `useTabDialogs` hook:
 *
 *   tab+fresh     → a sibling engine tab (`addTab`)
 *   tab+continue  → refusal toast when there is no conversation yet
 *   fork+fresh    → the QuickTaskComposer, submit reaches `onQuickFork`
 *   fork+continue → composer with the handoff brief leading the prompt;
 *                   refusal toast (no composer) without a session
 *
 * Engine history reads and kobe state writes are both sandboxed to a
 * tmpdir via their real env seams (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` /
 * `KOBE_HOME_DIR`) — bun's `os.homedir()` ignores runtime `HOME` changes,
 * so plain-HOME sandboxing silently reads the real home.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { encodeCwd } from "../../src/engine/claude-code-local/history"
import type { QuickTaskResult } from "../../src/tui-react/component/quick-task-composer"
import { useT } from "../../src/tui-react/i18n"
import { useDialog } from "../../src/tui-react/ui/dialog"
import { type NewChatPreset, useTabDialogs } from "../../src/tui-react/workspace/use-tab-dialogs"
import type { TabsState } from "../../src/tui/workspace/terminal-tabs-core"
import { act, renderComponent, settle } from "./harness"

let root: string
let repo: string
let worktree: string
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "KOBE_HOME_DIR"] as const

function git(cwd: string, ...args: string[]): void {
  const out = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf-8" })
  if (out.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr}`)
}

beforeAll(() => {
  // realpath: on darwin mkdtemp hands back `/var/…` but git resolves the
  // `/private/var` symlink, and the flow compares repo paths from git.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kobe-new-chat-flow-")))
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude-config")
  process.env.CODEX_HOME = path.join(root, "codex-home")
  process.env.KOBE_HOME_DIR = path.join(root, "kobe-home")
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true })
  fs.mkdirSync(process.env.KOBE_HOME_DIR, { recursive: true })
  repo = path.join(root, "repo")
  worktree = path.join(root, "wt")
  fs.mkdirSync(repo)
  git(repo, "init", "-b", "main")
  git(repo, "commit", "--allow-empty", "-m", "init")
  git(repo, "worktree", "add", "-b", "kobe/parent", worktree)
})

afterAll(() => {
  // Restore the sandbox env — bun test runs every file in one process, so
  // leaked overrides would redirect later files' state/history reads.
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  fs.rmSync(root, { recursive: true, force: true })
})

function tabs(sessionId?: string): TabsState {
  return {
    tabs: [{ kind: "engine", id: "tab-1", title: null, ordinal: 1, vendor: "claude", sessionId }],
    activeId: "tab-1",
    nextOrdinal: 2,
  }
}

interface Captured {
  updates: TabsState[]
  errors: string[]
  forks: { repo: string; result: QuickTaskResult }[]
  request: (preset?: NewChatPreset) => void
}

function Driver(props: { state: TabsState; captured: Captured }) {
  const dialog = useDialog()
  const t = useT()
  const api = useTabDialogs({
    dialog,
    t,
    state: props.state,
    active: props.state.tabs[0]!,
    vendor: "claude",
    worktree,
    liveTitles: new Map(),
    update: (next) => props.captured.updates.push(next),
    pinSession: (s) => s,
    activeLeafSize: () => null,
    onQuickFork: (r, result) => props.captured.forks.push({ repo: r, result }),
    notifyError: (title) => props.captured.errors.push(title),
  })
  props.captured.request = api.requestNewChat
  return null
}

async function mountFlow(state: TabsState) {
  const captured: Captured = { updates: [], errors: [], forks: [], request: () => {} }
  const handle = await renderComponent(<Driver state={state} captured={captured} />, {
    providers: { dialog: true, notifications: true },
  })
  return { ...handle, captured }
}

describe("requestNewChat dispatch", () => {
  test("default combo lands a sibling engine tab (old ctrl+e)", async () => {
    const { frame, mockInput, captured } = await mountFlow(tabs())
    act(() => captured.request())
    await settle()
    expect(await frame()).toContain("New conversation")
    act(() => mockInput.pressEnter())
    await settle()
    await frame()
    expect(captured.updates).toHaveLength(1)
    const next = captured.updates[0]!
    expect(next.tabs).toHaveLength(2)
    expect(next.tabs[1]).toMatchObject({ kind: "engine", vendor: "claude" })
    expect(captured.errors).toHaveLength(0)
  })

  test("tab+continue with no conversation → refusal toast, no tab", async () => {
    const { frame, mockInput, captured } = await mountFlow(tabs())
    act(() => captured.request({ context: "continue" }))
    await settle()
    expect(await frame()).toContain("continue this conversation")
    act(() => mockInput.pressEnter())
    await settle()
    await frame()
    expect(captured.updates).toHaveLength(0)
    expect(captured.errors).toEqual(["No conversation in this tab to fork yet"])
  })

  test("fork+fresh opens the QuickTaskComposer; submit reaches onQuickFork", async () => {
    const { frame, mockInput, captured } = await mountFlow(tabs())
    act(() => captured.request({ destination: "fork" }))
    await settle()
    expect(await frame()).toContain("fork a child task")
    act(() => mockInput.pressEnter())
    await settle()
    expect(await frame()).toContain("Quick task")
    await act(async () => mockInput.typeText("ship the thing"))
    act(() => mockInput.pressEnter())
    await settle()
    await frame()
    expect(captured.forks).toHaveLength(1)
    expect(captured.forks[0]!.repo).toBe(repo)
    expect(captured.forks[0]!.result).toMatchObject({
      prompt: "ship the thing",
      vendor: "claude",
      baseRef: "kobe/parent",
    })
  })

  test("fork+continue leads the child's first prompt with the handoff brief", async () => {
    // Fabricate the transcript the handoff must point at, in the sandboxed
    // claude config dir.
    const projectDir = path.join(process.env.CLAUDE_CONFIG_DIR as string, "projects", encodeCwd(worktree))
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, "s1.jsonl"), "{}\n")

    const { frame, mockInput, captured } = await mountFlow(tabs("s1"))
    act(() => captured.request({ destination: "fork", context: "continue" }))
    await settle()
    act(() => mockInput.pressEnter())
    await settle()
    expect(await frame()).toContain("Quick task")
    await act(async () => mockInput.typeText("keep going"))
    act(() => mockInput.pressEnter())
    await settle()
    await frame()
    expect(captured.forks).toHaveLength(1)
    const prompt = captured.forks[0]!.result.prompt
    expect(prompt).toContain("Continue the work from a previous")
    expect(prompt).toContain(path.join(projectDir, "s1.jsonl"))
    expect(prompt.endsWith("keep going")).toBe(true)
    expect(captured.errors).toHaveLength(0)
  })

  test("fork+continue with no conversation → refusal toast, composer never opens", async () => {
    // A codex tab with no session: codex history lives under the sandboxed
    // CODEX_HOME, which has no sessions — nothing to continue from.
    const { frame, mockInput, captured } = await mountFlow({
      tabs: [{ kind: "engine", id: "tab-1", title: null, ordinal: 1, vendor: "codex" }],
      activeId: "tab-1",
      nextOrdinal: 2,
    })
    act(() => captured.request({ destination: "fork", context: "continue" }))
    await settle()
    act(() => mockInput.pressEnter())
    await settle()
    const after = await frame()
    expect(after).not.toContain("Quick task")
    expect(captured.errors).toEqual(["No conversation in this tab to fork yet"])
    expect(captured.forks).toHaveLength(0)
  })
})
