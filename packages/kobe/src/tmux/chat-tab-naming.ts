import { deriveTitleFromSession, deriveTitleFromSessionId } from "@/monitor/auto-title"
import type { Orchestrator } from "@/orchestrator/core"
import { CHAT_TAB_SESSION_ID_OPTION, runTmux, runTmuxCapturing, tmuxSessionName } from "@/tmux/client"
import { DEFAULT_TASK_VENDOR, type VendorId } from "@/types/task"

export interface TmuxRunner {
  capture(args: string[]): Promise<{ code: number; stdout: string }>
  run(args: string[]): Promise<number>
}

const realRunner: TmuxRunner = { capture: runTmuxCapturing, run: runTmux }

export interface ChatTabWindow {
  readonly index: number
  readonly sessionId: string
  readonly autoRename: string
}

export async function listChatTabWindows(session: string, runner: TmuxRunner = realRunner): Promise<ChatTabWindow[]> {
  const { code, stdout } = await runner.capture([
    "list-windows",
    "-t",
    `=${session}`,
    "-F",
    `#{window_index}\t#{automatic-rename}\t#{${CHAT_TAB_SESSION_ID_OPTION}}`,
  ])
  if (code !== 0) return []
  const out: ChatTabWindow[] = []
  for (const line of stdout.split("\n")) {
    const [indexField, autoRename, sessionId] = line.split("\t")
    const index = Number.parseInt((indexField ?? "").trim(), 10)
    if (!Number.isInteger(index)) continue
    out.push({ index, sessionId: sessionId?.trim() ?? "", autoRename: autoRename?.trim() ?? "" })
  }
  return out
}

async function windowNamedManually(session: string, index: number, runner: TmuxRunner): Promise<boolean> {
  const { code, stdout } = await runner.capture([
    "show-window-options",
    "-t",
    `=${session}:${index}`,
    "automatic-rename",
  ])
  return code === 0 && /\boff\b/.test(stdout)
}

async function globalAutomaticRenameOff(runner: TmuxRunner): Promise<boolean> {
  const { code, stdout } = await runner.capture(["show-window-options", "-g", "automatic-rename"])
  return code === 0 && /\boff\b/.test(stdout)
}

async function renameWindow(session: string, index: number, title: string, runner: TmuxRunner): Promise<boolean> {
  return (await runner.run(["rename-window", "-t", `=${session}:${index}`, "--", title])) === 0
}

export interface ChatTabNamingDeps {
  runner: TmuxRunner
  titleFromSessionId(vendor: VendorId, sessionId: string): Promise<string>
  titleFromWorktree(worktree: string, vendor: VendorId): Promise<string>
}

const realDeps: ChatTabNamingDeps = {
  runner: realRunner,
  titleFromSessionId: deriveTitleFromSessionId,
  titleFromWorktree: deriveTitleFromSession,
}

export async function runChatTabNamingPass(orch: Orchestrator, deps: ChatTabNamingDeps = realDeps): Promise<number> {
  let renamed = 0
  let globalOff: boolean | null = null
  const manuallyNamed = async (session: string, w: ChatTabWindow): Promise<boolean> => {
    if (w.autoRename === "1") return false
    if (w.autoRename === "0") {
      if (globalOff === null) globalOff = await globalAutomaticRenameOff(deps.runner)
      if (!globalOff) return true
    }
    return windowNamedManually(session, w.index, deps.runner)
  }
  for (const task of orch.listTasks()) {
    if (task.archived || task.kind === "main" || !task.worktreePath) continue
    const session = tmuxSessionName(task.id)
    const windows = await listChatTabWindows(session, deps.runner)
    if (windows.length === 0) continue
    const originIndex = windows.reduce((min, w) => Math.min(min, w.index), Number.POSITIVE_INFINITY)
    const vendor = task.vendor ?? DEFAULT_TASK_VENDOR
    for (const w of windows) {
      try {
        if (await manuallyNamed(session, w)) continue
        const title = w.sessionId
          ? await deps.titleFromSessionId(vendor, w.sessionId)
          : w.index === originIndex
            ? await deps.titleFromWorktree(task.worktreePath, vendor)
            : ""
        if (title && (await renameWindow(session, w.index, title, deps.runner))) renamed++
      } catch {}
    }
  }
  return renamed
}
