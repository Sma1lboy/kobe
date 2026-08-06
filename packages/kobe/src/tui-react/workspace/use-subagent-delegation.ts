/** Primary-task flow for linking one existing Task as a subagent. */

import { errorMessage } from "@/lib/error-message"
import { buildDelegationBootstrapPrompt } from "@/tui/workspace/task-delegation"
import type { Task } from "@/types/task"
import { TaskDelegationPickerDialog } from "../component/task-delegation-picker-dialog"
import type { DialogContext } from "../ui/dialog"

export interface DelegationOrchestrator {
  setDelegation(subagentId: string, primaryId: string): Promise<void>
}

export function useSubagentDelegation(args: {
  orchestrator: DelegationOrchestrator
  tasks: readonly Task[]
  primary: Task | undefined
  dialog: DialogContext
  t: (key: string, params?: Record<string, string | number>) => string
  sendRef: { readonly current: ((prompt: string) => void) | null }
  notifyError: (message: string) => void
  notifyInfo: (message: string) => void
}): { connectCurrent: () => void } {
  async function connectCurrent(): Promise<void> {
    const primary = args.primary
    if (!primary) return args.notifyError(args.t("delegation.toast.noPrimary"))
    const subagent = await TaskDelegationPickerDialog.show(args.dialog, primary, args.tasks)
    if (!subagent) return
    const sendToPrimary = args.sendRef.current
    if (!sendToPrimary) return args.notifyError(args.t("delegation.toast.noEngine"))
    try {
      await args.orchestrator.setDelegation(String(subagent.id), String(primary.id))
      sendToPrimary(buildDelegationBootstrapPrompt(primary, subagent))
      args.notifyInfo(args.t("delegation.toast.linked", { task: subagent.title }))
    } catch (err) {
      console.error("[kobe workspace] task delegation failed:", err)
      args.notifyError(args.t("delegation.toast.failed", { message: errorMessage(err) }))
    }
  }

  return { connectCurrent: () => void connectCurrent() }
}
