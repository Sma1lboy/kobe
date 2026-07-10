/** Worktree audit policy is supplied by the kobe host; the daemon owns routing. */

import type { DaemonRuntimeAdapter } from "./runtime.ts"

export function handleWorktreesRequest(runtime: DaemonRuntimeAdapter, request: Request, url: URL) {
  return runtime.handleWorktreesRequest(request, url)
}
