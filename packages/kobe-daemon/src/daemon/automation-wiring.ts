/**
 * Automation boot wiring, split out of `server.ts` (which is at its size cap
 * and is otherwise pure construction).
 */

import { AutomationsStore, defaultAutomationsPath } from "./automations-store.ts"
import { logDaemonError } from "./crash-log.ts"

/** Construct + load the store. A malformed automations file yields an empty
 *  store rather than a failed boot — same contract as the attention inbox. */
export async function initAutomationsStore(homeDir?: string): Promise<AutomationsStore> {
  const store = new AutomationsStore(defaultAutomationsPath(homeDir))
  await store.init().catch((err) => logDaemonError("automations-init", err))
  return store
}
