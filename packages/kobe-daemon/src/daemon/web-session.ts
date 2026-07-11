/** Task-session behavior is a host Adapter; the daemon owns the web route. */

import type { DaemonRpcClient } from "../client/rpc.ts"
import type { DaemonRuntimeAdapter } from "./runtime.ts"

export function ensureTaskSession(runtime: DaemonRuntimeAdapter, link: DaemonRpcClient, taskId: string) {
  return runtime.ensureTaskSession(link, taskId)
}

export function engineSpec(runtime: DaemonRuntimeAdapter, link: DaemonRpcClient, taskId: string) {
  return runtime.engineSpec(link, taskId)
}

export function terminalSpec(runtime: DaemonRuntimeAdapter, link: DaemonRpcClient, taskId: string) {
  return runtime.terminalSpec(link, taskId)
}

export function tearDownTaskSession(runtime: DaemonRuntimeAdapter, taskId: string) {
  return runtime.tearDownTaskSession(taskId)
}
