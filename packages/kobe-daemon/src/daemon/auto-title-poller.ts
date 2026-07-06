import { deriveTitleFromSession } from "@/monitor/auto-title"
import type { Orchestrator } from "@/orchestrator/core"
import { PLACEHOLDER_TASK_TITLE } from "@/orchestrator/core"
import { runChatTabNamingPass } from "@/tmux/chat-tab-naming"
import { DEFAULT_TASK_VENDOR, type VendorId } from "@/types/task"
import { logDaemonError } from "./crash-log"

export const DEFAULT_AUTO_TITLE_POLL_MS = 4000

export type TitleDeriver = (worktree: string, vendor: VendorId) => Promise<string>

export interface AutoTitled {
  readonly id: string
  readonly title: string
}

export async function runAutoTitlePass(
  orch: Orchestrator,
  derive: TitleDeriver = deriveTitleFromSession,
): Promise<AutoTitled[]> {
  const renamed: AutoTitled[] = []
  for (const task of orch.listTasks()) {
    if (task.archived || task.title !== PLACEHOLDER_TASK_TITLE || !task.worktreePath) continue
    try {
      const title = await derive(task.worktreePath, task.vendor ?? DEFAULT_TASK_VENDOR)
      if (!title) continue
      const current = orch.getTask(task.id)
      if (!current || current.title !== PLACEHOLDER_TASK_TITLE) continue
      await orch.setTitle(task.id, title)
      renamed.push({ id: task.id, title })
    } catch (err) {
      logDaemonError("auto-title-poller", err)
    }
  }
  return renamed
}

export function startAutoTitlePoller(
  orch: Orchestrator,
  intervalMs: number = DEFAULT_AUTO_TITLE_POLL_MS,
  hasSubscribers?: () => boolean,
): () => void {
  if (intervalMs <= 0) return () => {}
  let running = false
  const tick = (): void => {
    if (hasSubscribers && !hasSubscribers()) return
    if (running) return
    running = true
    void runAutoTitlePass(orch)
      .then(() => runChatTabNamingPass(orch))
      .catch((err) => logDaemonError("auto-title-poller", err))
      .finally(() => {
        running = false
      })
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
