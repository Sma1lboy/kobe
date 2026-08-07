import type { EngineActivityKind, VendorId } from "./contracts.ts"
import { logDaemonError } from "./crash-log.ts"
import type { DaemonRuntimeAdapter } from "./runtime.ts"

export interface SessionIdentityRecoveryInput {
  readonly runtime: DaemonRuntimeAdapter
  readonly kind: EngineActivityKind
  readonly tabId?: string
  readonly vendor: VendorId
  readonly worktreePath?: string
  readonly sessionId?: string
  readonly transcriptPath?: string
}

/**
 * Compatibility for an older globally-installed `kobe hook`: it can report
 * the exact task/tab session-start while omitting newer session fields. Only
 * that explicit lifecycle edge may ask the engine adapter to recover identity;
 * generic activity and UI messages never select a transcript.
 */
export async function recoverSessionIdentity(
  input: SessionIdentityRecoveryInput,
): Promise<{ sessionId?: string; transcriptPath?: string; source: "hook" | "history-recovery" }> {
  if (input.sessionId || !input.tabId || input.kind !== "session-start" || !input.worktreePath) {
    return {
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.transcriptPath ? { transcriptPath: input.transcriptPath } : {}),
      source: "hook",
    }
  }
  const recovered = await input.runtime.recoverEngineSession(input.vendor, input.worktreePath).catch((err) => {
    logDaemonError("session-bindings-recovery", err)
    return null
  })
  return recovered ? { ...recovered, source: "history-recovery" } : { source: "hook" }
}
