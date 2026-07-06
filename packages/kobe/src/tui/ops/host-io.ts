import { kobeCliInvocation } from "@/cli/invocation"
import { latestTranscriptMtime } from "@/monitor/activity"
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
import type { VendorId } from "@/types/task"
import { inheritedEnvPrefix } from "../panes/terminal/launch"
import { type BadgePollIo, CHAT_TAB_STATE_OPTION, type TurnStatusIo } from "./activity-monitor"
import { buildPRPrompt } from "./pr-prompt"

export function basename(p: string): string {
  const i = p.lastIndexOf("/")
  return i >= 0 ? p.slice(i + 1) : p
}

export interface OpsShellContext {
  readonly taskId: string
  readonly worktree: string
  readonly targetPane: string | null
}

export interface OpsActions {
  readonly openFile: (rel: string) => void
  readonly injectMention: (rel: string) => void
  readonly createPR: () => Promise<void>
  readonly toggleZen: () => void
}

export function makeOpsActions(ctx: OpsShellContext): OpsActions {
  function openPreview(rel: string): void {
    if (!ctx.taskId) return
    void newWindow(tmuxSessionName(ctx.taskId), {
      cwd: ctx.worktree,
      command: previewWindowCommand({ worktree: ctx.worktree, relPath: rel, cliInvocation: kobeCliInvocation() }),
      name: basename(rel),
    })
  }

  return {
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
    toggleZen(): void {
      if (!ctx.taskId) return
      const session = tmuxSessionName(ctx.taskId)
      const inv = kobeCliInvocation()
      const cmd = `${inheritedEnvPrefix()}${shellQuoteArgv(inv)} layout --session ${shellQuote(session)} --action zen-toggle`
      void runTmux(["run-shell", "-b", cmd])
    },
  }
}

export function badgePollIo(vendor: VendorId, worktree: string): BadgePollIo {
  return {
    sessionAttached,
    latestMtime: () => latestTranscriptMtime(vendor, worktree),
  }
}

export function turnStatusIo(targetPane: string): TurnStatusIo {
  return {
    sessionAttached,
    capturePane: () => capturePaneById(targetPane, 80),
    setTurnState: (state) => setWindowOption(targetPane, CHAT_TAB_STATE_OPTION, state),
  }
}
