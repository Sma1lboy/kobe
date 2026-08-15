/**
 * Spawn composition for an engine tab: argv (session pin / resume / fork)
 * plus the shell-wrapped launch, split out of `terminal-tabs-core.ts` (the
 * tab-list transitions) for the 500-line file-size cap. Re-exported from
 * core, so importers keep one entry point. Tab shapes come back from core
 * as TYPE-only imports — erased at build time, so the cycle is cosmetic.
 */

import {
  type EngineSessionLaunchTask,
  type EngineSessionProtocolGates,
  buildEngineSessionLaunch,
} from "@/engine/session-launch"
import { trustEngineWorktree } from "@/engine/trust-worktree"
import { forkSessionArgv } from "../../engine/interactive-command"
import type { TabSpawn } from "./terminal-tab-spawn"
import type { EngineTab, TabsState, TerminalTab } from "./terminal-tabs-core"

/**
 * Argv for an engine tab's PTY spawn. `base` is the tab's engine command
 * (vendor-pinned or the task's); `live` is whether the tab's PTY currently
 * exists in the registry. A fork tab (see `EngineTab.forkFrom`) opens ON
 * the source conversation's history — engine-owned flag shapes, and it only
 * applies to the tab's FIRST spawn (afterwards the fork is its own session,
 * resumed by id like any other). No pinned session id → the bare command
 * (codex/custom vendors). A tab that already spawned but has NO live PTY
 * (host restart, degrade re-acquire) resumes its conversation; otherwise the
 * id is pinned fresh — the flag shapes ride `withClaudeSessionId`'s existing
 * per-vendor contract, verbatim from the component it was extracted from.
 */
export function engineTabArgv(tab: EngineTab, base: readonly string[], live: boolean): readonly string[] {
  if (tab.forkFrom && !tab.spawned && !live) {
    // `tab.vendor` is always concrete on a fork tab (the chord pins it) —
    // guard anyway so an inherited-vendor tab can never get claude's flags.
    const forked = tab.vendor ? forkSessionArgv(base, tab.vendor, tab.forkFrom, tab.sessionId ?? null) : null
    if (forked) return forked
  }
  if (!tab.sessionId) return base
  if (tab.spawned && !live) return [...base, "--resume", tab.sessionId]
  return [...base, "--session-id", tab.sessionId]
}

/**
 * Full spawn composition for an engine tab — {@link engineTabArgv} wrapped
 * in the user's shell (`shellSpawn`), plus the quick-fork initial
 * prompt policy (issue #17, verified delivery 12283c57): `prompt` rides the
 * argv as a positional arg ONLY on the first engine tab's FIRST spawn —
 * never on a later engine tab, an already-spawned tab, or one whose PTY is
 * still live (re-render churn), so the prompt can't re-deliver. Pure so
 * vitest pins the rule; the component supplies the IO reads (`live` from
 * the registry, `prompt` from props, `shell` from the environment).
 */
export function engineTabSpawnFor(
  state: TabsState,
  tab: EngineTab,
  base: readonly string[],
  opts: {
    live: boolean
    shell: string
    prompt?: string
    task: EngineSessionLaunchTask
    worktreePath: string
    protocolGates?: EngineSessionProtocolGates
  },
): TabSpawn {
  const { live, shell, prompt } = opts
  const firstEngine = state.tabs.find((t) => t.kind === "engine")
  const fresh = !tab.spawned && !live
  // A tab-owned prompt (the cross-engine handoff brief) wins over the
  // task-level one, which by policy only ever reaches the FIRST engine tab.
  const tabPrompt = fresh ? tab.initialPrompt?.trim() : undefined
  const wantsPrompt = !!prompt && tab.id === firstEngine?.id && fresh
  const isFreshFirstEngine = tab.id === firstEngine?.id && fresh
  // Tab-owned prompts (cross-engine handoff on an existing worktree) stay
  // "explicit"; the task-level prompt only exists on a freshly created
  // worktree task (quick-fork, issue-chat), so it rides as "new-task" and
  // picks up the branch-rename coda.
  const promptIntent = tabPrompt
    ? ({ kind: "explicit", prompt: tabPrompt } as const)
    : wantsPrompt
      ? ({ kind: "new-task", prompt } as const)
      : isFreshFirstEngine
        ? ({ kind: "repo-init" } as const)
        : ({ kind: "none" } as const)
  // A viewport tab (see EngineTab.ptyTask) launches AS the referenced
  // task's first tab: its id, worktree, and tab identity — so activity,
  // hooks, and a dead-reattach resume all belong to the story's task.
  const ref = tab.ptyTask
  // Pre-trust the worktree in the vendor's first-run store (issue #28) — a
  // hosted session can't answer a trust dialog. The tab's pinned vendor wins.
  trustEngineWorktree(tab.vendor ?? opts.task.vendor, ref?.worktree ?? opts.worktreePath)
  const launch = buildEngineSessionLaunch({
    task: ref ? { ...opts.task, id: ref.id, kind: "task" } : opts.task,
    worktreePath: ref?.worktree ?? opts.worktreePath,
    shell,
    argv: engineTabArgv(tab, base, live),
    promptIntent,
    protocolGates: opts.protocolGates,
    // The TUI owns no post-spawn paste hook, so it keeps argv delivery even
    // for paste vendors (kimi). That preserves the pre-#25 behavior here —
    // a kimi tab-level prompt still fails loud in the engine — rather than
    // silently dropping the prompt. Wiring the TUI's own paste-after-ready
    // is the tracked follow-up.
    firstMessageDelivery: "argv",
    // Tab identity → exported env in the launch script: the engine's hook
    // subprocesses inherit it, so `kobe hook` can attribute activity to
    // THIS tab — cwd alone can't (every tab of a task shares the worktree).
    tabId: ref ? "tab-1" : tab.id,
  })
  return { command: launch.command }
}

export type TabExitAction = "close" | "resume"

/**
 * Policy for the ACTIVE tab's process exiting. Engine tabs run their CLI
 * inside the user's shell (`shellSpawn`), so a live PTY exit means
 * the SHELL ended — the tab closes, same as a command tab (editor quit,
 * shell exit). An engine tab found dead ON ATTACH (host restart /
 * park-sweep corpse) with a resumable session gets ONE resume attempt —
 * `resumeTried` is the per-tab one-shot guard, so a `--resume` that
 * itself dies closes normally instead of respawning forever.
 */
export function tabExitAction(tab: TerminalTab, deadOnAttach: boolean, resumeTried: boolean): TabExitAction {
  if (tab.kind === "engine" && deadOnAttach && !!tab.sessionId && tab.spawned && !resumeTried) return "resume"
  return "close"
}
