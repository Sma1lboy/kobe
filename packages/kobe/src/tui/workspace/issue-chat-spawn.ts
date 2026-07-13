/**
 * Background issue-chat spawn composition — the kanban board's "trigger"
 * path. A background Start (`worktreeBg`, `state/issue-chat.ts`) must
 * actually LAUNCH the engine session, not park a prompt for the first
 * visit: the caller feeds this composition to `PtyRegistry.acquire` under
 * the task's first-tab key, so the hosted PTY starts working immediately
 * while the user stays on the board tracking the card.
 *
 * The composition mirrors `TerminalTabs`' first-tab spawn exactly —
 * `initialTabs()` + a pinned session id + `engineTabSpawnFor` with the
 * story prompt — so a later visit to the task ATTACHES to the same live
 * PTY (same `tabPtyKey`) instead of respawning. `tabsSnapshot` is the
 * matching persisted tab state (spawned=true): written to the
 * `terminalTabs.<taskId>` kv slot, it makes the visit rehydrate onto this
 * session and, after a host restart, `--resume` it.
 */

import { interactiveEngineCommand, withClaudeSessionId } from "@/engine/interactive-command"
import type { VendorId } from "@/types/vendor"
import type { Issue } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import { issueWorktreePrompt } from "../../state/issue-chat"
import { defaultShell } from "../panes/terminal/pty-types"
import {
  type EngineTab,
  type TabsState,
  engineTabSpawnFor,
  initialTabs,
  setTabSpawned,
  tabPtyKey,
} from "./terminal-tabs-core"

export interface IssueChatBackgroundSpawn {
  /** Registry key for the task's first engine tab (`taskId::tab-1`). */
  readonly ptyKey: string
  readonly command: readonly string[]
  readonly initialInput?: string
  /** Persist to `terminalTabsKey(taskId)` so a visit attaches, not respawns. */
  readonly tabsSnapshot: TabsState
}

/** Compose the headless first-tab engine launch for a story's new task. */
export function buildIssueChatBackgroundSpawn(input: {
  issue: Issue
  taskId: string
  repoRoot: string
  worktreePath: string
  vendor: VendorId
  /** Shell-ready `kobe api` prefix for the prompt's status protocol. */
  api: string
  shell?: string
}): IssueChatBackgroundSpawn {
  const base = interactiveEngineCommand(input.vendor)
  const { sessionId } = withClaudeSessionId(base, input.vendor)
  const fresh = initialTabs()
  const tab: EngineTab = { ...(fresh.tabs[0] as EngineTab), sessionId }
  const state: TabsState = { ...fresh, tabs: [tab] }
  const spawn = engineTabSpawnFor(state, tab, base, {
    live: false,
    shell: input.shell ?? defaultShell(),
    prompt: issueWorktreePrompt(input.issue, input.api),
    task: { id: input.taskId, kind: "task", vendor: input.vendor, repo: input.repoRoot },
    worktreePath: input.worktreePath,
  })
  return {
    ptyKey: tabPtyKey(input.taskId, tab.id),
    command: spawn.command,
    initialInput: spawn.initialInput,
    tabsSnapshot: setTabSpawned(state, tab.id, true),
  }
}
