/**
 * AI SDK harness backend for the native chat pane — the sole native-chat
 * backend (KOBE_TUI=1), following mc-launcher's local-runtime engine
 * (`packages/agent-core/src/harness/index.ts` in the sibling repo).
 *
 * `HarnessAgent` + `createClaudeCode()` drive the locally-installed Claude
 * Code runtime through a bridge; `createLocalSandbox` makes that bridge run
 * ON THIS MACHINE rooted at the task worktree, so the runtime reuses the
 * local `claude` subscription login — no API key. Unlike mc-launcher, kobe
 * KEEPS the runtime's builtin coding tools (bash/read/edit/…): a coding
 * agent in its worktree is exactly the product.
 *
 * The stream contract is the AI SDK's own: `readUIMessageStream` yields a
 * GROWING assistant `UIMessage` snapshot per chunk; the pane replaces its
 * tail message on every update (no delta bookkeeping, no mapping layer —
 * the UIMessage parts ARE the render schema on this path).
 *
 * ponytail: turn results are ephemeral — nothing here persists the UIMessage
 * history to claude's on-disk session-record format. That conversion is
 * future work handled by a one-way adapter at the persistence boundary (the
 * UIMessage schema is Vercel-owned; the session record is claude-owned), NOT
 * in this stream path. Don't build it here.
 */

import type { VendorId } from "@/types/vendor"
import { createClaudeCode } from "@ai-sdk/harness-claude-code"
import { type CodexHarnessSettings, createCodex } from "@ai-sdk/harness-codex"
import { HarnessAgent } from "@ai-sdk/harness/agent"
import { getErrorMessage } from "@ai-sdk/provider-utils"
import { type UIMessage, readUIMessageStream } from "ai"
import { createLocalSandbox } from "./local-sandbox"

export type AiSdkHarnessVendor = "claude" | "codex"
type CodexReasoningEffort = NonNullable<CodexHarnessSettings["reasoningEffort"]>

/**
 * Turn failure surfaced to the pane. `runtimeBusy` is a kobe-authored
 * condition the pane translates (i18n); `message` carries a raw runtime/stream
 * error string, which is diagnostic and rendered verbatim.
 */
export type AiSdkTurnError = { readonly code: "runtimeBusy" } | { readonly message: string }

interface WorktreeRuntime {
  readonly agent: HarnessAgent
  readonly vendor: AiSdkHarnessVendor
  readonly worktree: string
  session?: Awaited<ReturnType<HarnessAgent["createSession"]>>
  busy: boolean
}

// One harness runtime per (vendor, worktree), created on first turn. The bridge
// keeps a child process alive, so panes must call disposeAiSdkRuntime on unmount.
const runtimes = new Map<string, WorktreeRuntime>()

export function resolveAiSdkHarnessVendor(vendor: VendorId | undefined): AiSdkHarnessVendor {
  return vendor === "codex" ? "codex" : "claude"
}

export function aiSdkRuntimeKey(vendor: AiSdkHarnessVendor, worktree: string): string {
  return `${vendor}:${worktree}`
}

export function codexReasoningEffort(effort: string | undefined): CodexReasoningEffort | undefined {
  return effort === "low" || effort === "medium" || effort === "high" ? effort : undefined
}

function createHarness(opts: {
  readonly vendor: AiSdkHarnessVendor
  readonly model?: string
  readonly modelEffort?: string
}) {
  if (opts.vendor === "codex") {
    const effort = codexReasoningEffort(opts.modelEffort)
    return createCodex({
      ...(opts.model ? { model: opts.model } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
    })
  }
  return createClaudeCode({
    ...(opts.model ? { model: opts.model } : {}),
  })
}

function ensureRuntime(opts: {
  readonly vendor: AiSdkHarnessVendor
  readonly worktree: string
  readonly model?: string
  readonly modelEffort?: string
}): WorktreeRuntime {
  const key = aiSdkRuntimeKey(opts.vendor, opts.worktree)
  const existing = runtimes.get(key)
  if (existing) return existing
  const runtime: WorktreeRuntime = {
    vendor: opts.vendor,
    worktree: opts.worktree,
    agent: new HarnessAgent({
      harness: createHarness(opts),
      sandbox: createLocalSandbox({ workRoot: opts.worktree }),
    }),
    busy: false,
  }
  runtimes.set(key, runtime)
  return runtime
}

export function disposeAiSdkRuntime(worktree: string): void {
  for (const [key, runtime] of runtimes) {
    if (runtime.worktree !== worktree) continue
    runtimes.delete(key)
    void runtime.session?.destroy().catch(() => {})
  }
}

export interface AiSdkTurnOpts {
  readonly worktree: string
  readonly vendor?: VendorId
  readonly model?: string
  readonly modelEffort?: string
  readonly prompt: string
  /** Growing assistant snapshot per stream chunk — replace the tail message. */
  readonly onUpdate: (assistant: UIMessage) => void
}

export interface AiSdkTurn {
  /** Resolves when the turn ends; `error` set on stream/setup failure. */
  readonly done: Promise<{ error?: AiSdkTurnError }>
  interrupt(): void
}

export function startAiSdkTurn(opts: AiSdkTurnOpts): AiSdkTurn {
  const controller = new AbortController()

  const done = (async (): Promise<{ error?: AiSdkTurnError }> => {
    const runtime = ensureRuntime({
      vendor: resolveAiSdkHarnessVendor(opts.vendor),
      worktree: opts.worktree,
      model: opts.model,
      modelEffort: opts.modelEffort,
    })
    if (runtime.busy) return { error: { code: "runtimeBusy" } }
    runtime.busy = true
    let error: AiSdkTurnError | undefined
    try {
      runtime.session ??= await runtime.agent.createSession()
      const result = await runtime.agent.stream({
        session: runtime.session,
        prompt: opts.prompt,
        abortSignal: controller.signal,
      })
      const uiStream = result.toUIMessageStream({ sendReasoning: true })
      for await (const msg of readUIMessageStream({
        stream: uiStream,
        onError: (e: unknown) => {
          error = { message: getErrorMessage(e) }
        },
      })) {
        opts.onUpdate(msg as UIMessage)
      }
    } catch (e) {
      const aborted = controller.signal.aborted || (e instanceof Error && e.name === "AbortError")
      if (!aborted) error = { message: getErrorMessage(e) }
    } finally {
      runtime.busy = false
    }
    return { error }
  })()

  return { done, interrupt: () => controller.abort() }
}
