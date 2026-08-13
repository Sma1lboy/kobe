/**
 * Dispatcher provenance — the collaboration loop's reply address (issue #21).
 *
 * A task created from inside another kobe engine tab records WHO dispatched
 * it (`dispatcher: {taskId, tabId}`), and a bare `send` from that task
 * replies to exactly that tab. Completion has always been designed to flow
 * back through `send` into the dispatching chat tab (the `report`/`await`
 * verbs were removed in 55c990f34 in favour of it); this module is the
 * missing address that makes the route computable instead of hand-relayed.
 *
 * Both halves live here rather than in `handler-helpers.ts` so the stamping
 * (create-side) and the routing (send-side) stay one readable concern.
 */

import type { SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import type { DaemonRpc } from "../daemon-session.ts"
import { activeCliName } from "../rename-compat.ts"
import { ApiError, type ApiRuntime } from "./types.ts"

/** The dispatcher pair as recorded on a task. */
export type Dispatcher = NonNullable<SerializedTask["dispatcher"]>

/**
 * `task.create` payload fields naming the caller as the dispatcher.
 * `$KOBE_TASK_ID` / `$KOBE_TAB_ID` are exported into every engine tab
 * (`session-launch.ts`), and are read HERE in the CLI process — the daemon
 * has no caller env of its own. A create from a plain shell contributes
 * nothing. Tab floor `tab-1` = the canonical first engine tab.
 */
export function dispatcherEnvPayload(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const taskId = env.KOBE_TASK_ID
  if (!taskId) return {}
  return { dispatcherTaskId: taskId, dispatcherTabId: env.KOBE_TAB_ID || "tab-1" }
}

/**
 * The dispatcher recorded on the CALLER's own task, when the caller is a
 * kobe session that has one. `null` (keep the active-task default) when the
 * caller isn't a kobe session, the task predates the field or was created
 * outside a kobe session, or the env id is stale.
 */
export async function readOwnDispatcher(daemon: DaemonRpc): Promise<Dispatcher | null> {
  const selfId = process.env.KOBE_TASK_ID
  if (!selfId) return null
  try {
    const res = await daemon.request<{ task: SerializedTask }>("task.get", { taskId: selfId })
    return res.task.dispatcher ?? null
  } catch {
    return null
  }
}

/**
 * Pick the tab a dispatcher-defaulted `send` lands on: the exact tab the
 * work was dispatched from first, the dispatcher task's canonical live
 * engine tab when that tab has died, and NEVER a silent spawn — with
 * nothing alive the send fails loud with a typed error, per the 2026-08-12
 * collaboration-verb design principle (a fallback must not impersonate
 * success). `undefined` means "the canonical tab", the delivery layer's own
 * spelling for it.
 */
export async function resolveDispatcherTab(runtime: ApiRuntime, dispatcher: Dispatcher): Promise<string | undefined> {
  const { tabs, running } = await runtime.taskTabs(dispatcher.taskId)
  // The dispatched-from tab first, addressed only when it reads ALIVE: the
  // tab join now also lists live sessions the persisted snapshot never
  // registered (issue #20), so "present and alive" is the honest liveness
  // test and a tab that is merely gone from the snapshot still gets the
  // canonical fallback below instead of a TAB_NOT_FOUND at delivery.
  if (tabs.some((t) => t.id === dispatcher.tabId && t.alive)) return dispatcher.tabId
  // Dead dispatcher tab → the task's canonical live engine, gated on a live
  // engine tab existing. The canonical path legitimately COLD-STARTS an
  // engine for a task with no alive session at all (issue #19) — correct for
  // a first prompt, wrong for a reply: it would boot an engine nobody asked
  // for and address it as if it were the agent that dispatched the work.
  if (running) return undefined
  throw new ApiError(
    `dispatcher tab ${dispatcher.tabId} on task ${dispatcher.taskId} is dead and the task has no live engine tab — the reply has nowhere to land`,
    "DISPATCHER_UNREACHABLE",
    {
      dispatcher,
      hint: `address an alive target explicitly with --task-id/--tab (see \`${activeCliName()} api pty-list\`), or notify the user with \`${activeCliName()} api notify\``,
      nextCommandArgs: ["api", "pty-list"],
    },
  )
}
