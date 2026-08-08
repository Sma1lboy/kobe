/** Stateless cross-Task address handoff for `prefix+@`. */

import { buildTaskContactPrompt } from "@/tui/workspace/task-messaging"
import type { Task } from "@/types/task"
import { TaskMessagePickerDialog } from "../component/task-message-picker-dialog"
import type { DialogContext } from "../ui/dialog"

export function useTaskMessaging(args: {
  tasks: readonly Task[]
  current: Task | undefined
  dialog: DialogContext
  t: (key: string, params?: Record<string, string | number>) => string
  sendRef: { readonly current: ((prompt: string) => void) | null }
  notifyError: (message: string) => void
  notifyInfo: (message: string) => void
}): { choosePeer: () => void } {
  async function choosePeer(): Promise<void> {
    const current = args.current
    if (!current) return args.notifyError(args.t("taskMessaging.toast.noCurrent"))
    const peer = await TaskMessagePickerDialog.show(args.dialog, current, args.tasks)
    if (!peer) return
    const send = args.sendRef.current
    if (!send) return args.notifyError(args.t("taskMessaging.toast.noEngine"))
    send(buildTaskContactPrompt(current, peer))
    args.notifyInfo(args.t("taskMessaging.toast.ready", { task: peer.title }))
  }

  return { choosePeer: () => void choosePeer() }
}
