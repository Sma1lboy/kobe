/**
 * Barrel that combines every per-category handler map into a single
 * `Record<wireName, DaemonHandler>`. The daemon's request loop looks up
 * the handler by `req.name`; unknown names fall through to a 404 error
 * in the caller.
 */

import type { DaemonHandler } from "../context.ts"
import { chatHandlers } from "./chat.ts"
import { lifecycleHandlers } from "./lifecycle.ts"
import { prMergeHandlers } from "./pr-merge.ts"
import { rcBridgeHandlers } from "./rc-bridge.ts"
import { tabHandlers } from "./tabs.ts"
import { taskHandlers } from "./tasks.ts"

export const daemonHandlers: Record<string, DaemonHandler> = {
  ...lifecycleHandlers,
  ...taskHandlers,
  ...tabHandlers,
  ...chatHandlers,
  ...prMergeHandlers,
  ...rcBridgeHandlers,
}
