/**
 * Real-world side of the Ops pane, extracted from `tui/ops/host.tsx` so the
 * Solid AND React hosts (issue #15, G3) share it verbatim: the user-facing
 * shell actions (open file / preview / @mention / create PR / zen toggle)
 * plus the concrete IO sets the framework-free poll loops in
 * `./activity-monitor` consume. No Solid, no React — plain functions over
 * tmux + git.
 */

import { kobeCliInvocation } from "@/cli/invocation"
import {
  capturePaneById,
  newWindow,
  runTmux,
  sendKeyName,
  sendKeys,
  setWindowOption,
  tmuxSessionName,
} from "@/tmux/client"
import { openInEditor } from "@/tmux/editor-launch"
import { previewWindowCommand, shellQuote, shellQuoteArgv } from "@/tmux/session-layout"
import { sessionAttached } from "@/tui/lib/attach-gate"
import { pathLeaf } from "@/tui/lib/path-helpers"
import { inheritedEnvPrefix } from "../panes/terminal/launch"
import { CHAT_TAB_STATE_OPTION, type TurnStatusIo } from "./activity-monitor"
import { buildPRPrompt } from "./pr-prompt"

/** The launcher-provided identity of one Ops pane (see `OpsHostArgs`). */
export interface OpsShellContext {
  readonly taskId: string
  readonly worktree: string
  readonly targetPane: string | null
}

export interface OpsActions {
  /** enter on a file → editor window, falling back to the opentui preview. */
  readonly openFile: (rel: string) => void
  /** `a` — inject `@<path> ` into the engine pane (no Enter). */
  readonly injectMention: (rel: string) => void
  /** `p` — send the PR prompt to the engine pane and submit it. */
  readonly createPR: () => Promise<void>
  /** Zen chip — toggle zen layout via tmux `run-shell -b` (survives this pane's death). */
  readonly toggleZen: () => void
}

/** Build the Ops pane's shell actions. Same guards as the original host:
 * a standalone `kobe ops` (no task id / target pane) degrades gracefully. */
export function makeOpsActions(ctx: OpsShellContext): OpsActions {
  // Open the file's diff/content in a full-width preview window of the
  // task's tmux session (`kobe-<taskId>`). Without a task id there is no
  // session to target — bail rather than fire at a phantom.
  function openPreview(rel: string): void {
    if (!ctx.taskId) return
    void newWindow(tmuxSessionName(ctx.taskId), {
      cwd: ctx.worktree,
      command: previewWindowCommand({ worktree: ctx.worktree, relPath: rel, cliInvocation: kobeCliInvocation() }),
      name: pathLeaf(rel),
    })
  }

  return {
    // One-key "just open it": the user's nvim/vim in a fresh tmux window
    // (side-by-side `nvim -d` diff vs HEAD when changed, plain open
    // otherwise); only when no editor can launch do we fall back to the
    // read-only opentui preview — enter is never a dead key. A standalone
    // `kobe ops` (no task id) has no session for an editor window, so it
    // just previews.
    openFile(rel: string): void {
      if (!ctx.taskId) {
        openPreview(rel)
        return
      }
      const abs = `${ctx.worktree}/${rel}`
      void openInEditor(tmuxSessionName(ctx.taskId), ctx.worktree, abs).then((launched) => {
        if (!launched) openPreview(rel)
      })
    },
    // Literal send (`sendKeys` uses `-l`), trailing space, NO Enter — the
    // user decides when to submit and can queue several mentions. No-op
    // without a target pane (standalone invocation).
    injectMention(rel: string): void {
      if (!ctx.targetPane) return
      void sendKeys(ctx.targetPane, `@${rel} `)
    },
    async createPR(): Promise<void> {
      if (!ctx.targetPane) return
      const prompt = await buildPRPrompt(ctx.worktree)
      await sendKeys(ctx.targetPane, prompt)
      await sendKeyName(ctx.targetPane, "Enter")
    },
    // Entering zen kills THIS pane, so the action must not run in-process —
    // SIGHUP would abort it half-done. tmux `run-shell -b` runs it detached
    // from any pane (same path as the prefix-space chord), surviving this
    // pane's death. A standalone `kobe ops` has no session to act on.
    toggleZen(): void {
      if (!ctx.taskId) return
      const session = tmuxSessionName(ctx.taskId)
      const inv = kobeCliInvocation()
      const cmd = `${inheritedEnvPrefix()}${shellQuoteArgv(inv)} layout --session ${shellQuote(session)} --action zen-toggle`
      void runTmux(["run-shell", "-b", cmd])
    },
  }
}

/** The real IO set for `startTurnStatusPoll` against the paired engine pane. */
export function turnStatusIo(targetPane: string): TurnStatusIo {
  return {
    sessionAttached,
    capturePane: () => capturePaneById(targetPane, 80),
    setTurnState: (state) => setWindowOption(targetPane, CHAT_TAB_STATE_OPTION, state),
  }
}
