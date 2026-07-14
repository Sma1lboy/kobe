/**
 * Issue-chat spawn compositions — the kanban board's "trigger" paths. A
 * Start must actually LAUNCH the engine session, not park a prompt for the
 * first visit: the caller feeds these compositions to `PtyRegistry.acquire`
 * so the hosted PTY starts working immediately, whether the user jumps in
 * or stays on the board tracking the card (`state/issue-chat.ts` for the
 * placement grammar).
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

/**
 * Headless spawn for a story chattab APPENDED to an existing task's strip —
 * the `project` placement: `tab` is the already-persisted entry from
 * `appendBackgroundEngineTab` (spawned=true on disk), so the spawn composes
 * from its UNSPAWNED view — fresh `--session-id`, prompt riding — while a
 * SYNTHETIC single-tab state satisfies the first-tab prompt policy (the
 * host task's real tab-1 already consumed its own first spawn).
 */
export function buildIssueTabSpawn(input: {
  /** The task hosting the tab (the repo's main task) + its checkout. */
  taskId: string
  repoRoot: string
  worktreePath: string
  tab: EngineTab
  vendor: VendorId
  prompt: string
  shell?: string
}): { readonly ptyKey: string; readonly command: readonly string[] } {
  const base = interactiveEngineCommand(input.vendor)
  const fresh: EngineTab = { ...input.tab, spawned: false }
  const synthetic: TabsState = { tabs: [fresh], activeId: fresh.id, nextOrdinal: fresh.ordinal + 1 }
  const spawn = engineTabSpawnFor(synthetic, fresh, base, {
    live: false,
    shell: input.shell ?? defaultShell(),
    prompt: input.prompt,
    task: { id: input.taskId, kind: "main", vendor: input.vendor, repo: input.repoRoot },
    worktreePath: input.worktreePath,
  })
  return { ptyKey: tabPtyKey(input.taskId, fresh.id), command: spawn.command }
}
