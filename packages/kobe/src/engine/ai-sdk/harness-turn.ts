/**
 * AI SDK harness backend for the native chat pane (KOBE_AISDK=1) — the
 * provider-runtime spike, following mc-launcher's local-runtime engine
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
 */

import { createClaudeCode } from "@ai-sdk/harness-claude-code"
import { HarnessAgent } from "@ai-sdk/harness/agent"
import { type UIMessage, readUIMessageStream } from "ai"
import { createLocalSandbox } from "./local-sandbox"

interface WorktreeRuntime {
  readonly agent: HarnessAgent
  session?: Awaited<ReturnType<HarnessAgent["createSession"]>>
  busy: boolean
}

// One harness runtime per worktree, created on first turn. The bridge keeps
// a child process alive, so panes must call disposeAiSdkRuntime on unmount.
const runtimes = new Map<string, WorktreeRuntime>()

function ensureRuntime(worktree: string): WorktreeRuntime {
  const existing = runtimes.get(worktree)
  if (existing) return existing
  const runtime: WorktreeRuntime = {
    agent: new HarnessAgent({
      harness: createClaudeCode({}),
      sandbox: createLocalSandbox({ workRoot: worktree }),
    }),
    busy: false,
  }
  runtimes.set(worktree, runtime)
  return runtime
}

export function disposeAiSdkRuntime(worktree: string): void {
  const runtime = runtimes.get(worktree)
  runtimes.delete(worktree)
  void runtime?.session?.destroy().catch(() => {})
}

export interface AiSdkTurnOpts {
  readonly worktree: string
  readonly prompt: string
  /** Growing assistant snapshot per stream chunk — replace the tail message. */
  readonly onUpdate: (assistant: UIMessage) => void
}

export interface AiSdkTurn {
  /** Resolves when the turn ends; `error` set on stream/setup failure. */
  readonly done: Promise<{ error?: string }>
  interrupt(): void
}

export function startAiSdkTurn(opts: AiSdkTurnOpts): AiSdkTurn {
  const controller = new AbortController()

  const done = (async (): Promise<{ error?: string }> => {
    const runtime = ensureRuntime(opts.worktree)
    if (runtime.busy) return { error: "ai-sdk runtime busy — turns are sequential" }
    runtime.busy = true
    let error: string | undefined
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
          error = errText(e)
        },
      })) {
        opts.onUpdate(msg as UIMessage)
      }
    } catch (e) {
      const aborted = controller.signal.aborted || (e instanceof Error && e.name === "AbortError")
      if (!aborted) error = errText(e)
    } finally {
      runtime.busy = false
    }
    return { error }
  })()

  return { done, interrupt: () => controller.abort() }
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === "string") return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}
