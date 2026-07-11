/** Settings policy is supplied by the kobe host; the daemon owns routing. */

import type { DaemonRuntimeAdapter } from "./runtime.ts"

export function settingsSnapshot(runtime: DaemonRuntimeAdapter): Response {
  return runtime.settingsSnapshot()
}

export function settingsPatch(runtime: DaemonRuntimeAdapter, request: Request): Promise<Response> {
  return runtime.settingsPatch(request)
}
