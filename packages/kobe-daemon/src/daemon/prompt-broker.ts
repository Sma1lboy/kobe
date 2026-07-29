/**
 * Pending host-dialog prompts (`ui.prompt` → TUI dialog → `ui.promptReply`).
 * One entry per in-flight request; first settle wins (several attached TUIs
 * may all show the dialog), later replies are dropped as `ok: false`.
 */

export type PromptResult =
  | { readonly value: string }
  | { readonly cancelled: true; readonly reason: "cancelled" | "timeout" }

type Pending = {
  readonly resolve: (result: PromptResult) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export class PromptBroker {
  private readonly pending = new Map<string, Pending>()

  /** Register a prompt; resolves on reply or with a timeout cancellation. */
  create(promptId: string, timeoutMs: number): Promise<PromptResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(promptId)
        resolve({ cancelled: true, reason: "timeout" })
      }, timeoutMs)
      this.pending.set(promptId, { resolve, timer })
    })
  }

  /** Settle a prompt from a TUI reply. False when unknown/already settled. */
  settle(promptId: string, result: PromptResult): boolean {
    const entry = this.pending.get(promptId)
    if (!entry) return false
    this.pending.delete(promptId)
    clearTimeout(entry.timer)
    entry.resolve(result)
    return true
  }

  /** Cancel everything (daemon shutdown) so no caller hangs. */
  clear(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve({ cancelled: true, reason: "cancelled" })
      this.pending.delete(id)
    }
  }
}
