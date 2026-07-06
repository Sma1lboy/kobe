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
 * The provider runtime session is the model-friendly context path: Kobe parks
 * the harness session on runtime rebuild/dispose and later resumes it with the
 * same `sessionId + resumeFrom` payload. Kobe-owned UI history is only a bridge
 * when no provider session can be resumed.
 */

import {
  type NativeChatSessionRecord,
  clearNativeChatSession,
  readNativeChatSession,
  writeNativeChatSession,
} from "@/state/native-chat-session"
import type { VendorId } from "@/types/vendor"
import { createClaudeCode } from "@ai-sdk/harness-claude-code"
import { type CodexHarnessSettings, createCodex } from "@ai-sdk/harness-codex"
import { HarnessAgent, type HarnessAgentResumeSessionState } from "@ai-sdk/harness/agent"
import { getErrorMessage } from "@ai-sdk/provider-utils"
import { type UIMessage, readUIMessageStream } from "ai"
import { createLocalSandbox } from "./local-sandbox"

export type AiSdkHarnessVendor = "claude" | "codex"
export type AiSdkRuntimePurpose = "chat" | "router"
type CodexReasoningEffort = NonNullable<CodexHarnessSettings["reasoningEffort"]>
type HarnessSession = Awaited<ReturnType<HarnessAgent["createSession"]>>

export interface AiSdkConversationMessage {
  readonly role: "user" | "assistant"
  readonly text: string
}

export interface BuildPromptWithHistoryOpts {
  readonly historyTokenBudget?: number
}

const APPROX_CHARS_PER_TOKEN = 4
const DEFAULT_HISTORY_TOKEN_BUDGET = 128_000
const MAX_HISTORY_TOKEN_BUDGET = 800_000
const RESERVED_TURN_TOKENS = 16_000
const HISTORY_CONTEXT_FRACTION = 0.75

/**
 * Turn failure surfaced to the pane. `runtimeBusy` is a kobe-authored
 * condition the pane translates (i18n); `message` carries a raw runtime/stream
 * error string, which is diagnostic and rendered verbatim.
 */
export type AiSdkTurnError = { readonly code: "runtimeBusy" } | { readonly message: string }

interface WorktreeRuntime {
  readonly agent: HarnessAgent
  readonly vendor: AiSdkHarnessVendor
  readonly purpose: AiSdkRuntimePurpose
  readonly worktree: string
  // Settings the agent was built with; a later turn requesting a different
  // model/effort rebuilds the runtime rather than silently serving the old one.
  readonly model?: string
  readonly modelEffort?: string
  session?: HarnessSession
  busy: boolean
}

// One harness runtime per (vendor, worktree), created on first turn. The bridge
// keeps a child process alive, so panes must call disposeAiSdkRuntime on unmount.
const runtimes = new Map<string, WorktreeRuntime>()

export function resolveAiSdkHarnessVendor(vendor: VendorId | undefined): AiSdkHarnessVendor {
  return vendor === "codex" ? "codex" : "claude"
}

export function aiSdkRuntimeKey(
  vendor: AiSdkHarnessVendor,
  worktree: string,
  purpose: AiSdkRuntimePurpose = "chat",
): string {
  if (purpose !== "chat") return `${purpose}:${vendor}:${worktree}`
  return `${vendor}:${worktree}`
}

export function codexReasoningEffort(effort: string | undefined): CodexReasoningEffort | undefined {
  return effort === "low" || effort === "medium" || effort === "high" ? effort : undefined
}

function normalizeHistoryText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim()
}

export function historyTokenBudgetForContextWindow(contextWindowTokens: number | undefined): number {
  if (!contextWindowTokens || contextWindowTokens <= RESERVED_TURN_TOKENS) return DEFAULT_HISTORY_TOKEN_BUDGET
  const budget = Math.floor((contextWindowTokens - RESERVED_TURN_TOKENS) * HISTORY_CONTEXT_FRACTION)
  return Math.min(MAX_HISTORY_TOKEN_BUDGET, Math.max(0, budget))
}

function historyCharBudget(opts: BuildPromptWithHistoryOpts | undefined): number {
  const tokens = Math.max(0, opts?.historyTokenBudget ?? DEFAULT_HISTORY_TOKEN_BUDGET)
  return Math.floor(tokens * APPROX_CHARS_PER_TOKEN)
}

function boundedHistory(
  history: readonly AiSdkConversationMessage[] | undefined,
  opts?: BuildPromptWithHistoryOpts,
): readonly AiSdkConversationMessage[] {
  if (!history?.length) return []
  const out: AiSdkConversationMessage[] = []
  let chars = 0
  const charBudget = historyCharBudget(opts)
  for (const msg of [...history].reverse()) {
    const text = normalizeHistoryText(msg.text)
    if (!text) continue
    const next = { role: msg.role, text }
    chars += text.length
    if (chars > charBudget && out.length > 0) break
    out.push(next)
  }
  return out.reverse()
}

export function buildPromptWithHistory(
  prompt: string,
  history?: readonly AiSdkConversationMessage[] | undefined,
  opts?: BuildPromptWithHistoryOpts,
): string {
  const prior = boundedHistory(history, opts)
  if (prior.length === 0) return prompt
  const lines = ["Previous Kobe conversation:"]
  for (const msg of prior) {
    const label = msg.role === "assistant" ? "Assistant" : "User"
    lines.push(`${label}: ${msg.text}`)
  }
  lines.push("", "Current user prompt:", prompt)
  return lines.join("\n")
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

async function ensureRuntime(opts: {
  readonly vendor: AiSdkHarnessVendor
  readonly purpose?: AiSdkRuntimePurpose
  readonly worktree: string
  readonly model?: string
  readonly modelEffort?: string
}): Promise<WorktreeRuntime> {
  const purpose = opts.purpose ?? "chat"
  const key = aiSdkRuntimeKey(opts.vendor, opts.worktree, purpose)
  const existing = runtimes.get(key)
  if (existing && existing.model === opts.model && existing.modelEffort === opts.modelEffort) return existing
  if (existing) {
    if (existing.busy) return existing
    await parkRuntimeSession(existing)
  }
  const runtime: WorktreeRuntime = {
    vendor: opts.vendor,
    purpose,
    worktree: opts.worktree,
    model: opts.model,
    modelEffort: opts.modelEffort,
    agent: new HarnessAgent({
      harness: createHarness(opts),
      sandbox: createLocalSandbox({ workRoot: opts.worktree }),
    }),
    busy: false,
  }
  runtimes.set(key, runtime)
  return runtime
}

function sessionRef(runtime: WorktreeRuntime) {
  return { vendor: runtime.vendor, purpose: runtime.purpose, worktree: runtime.worktree }
}

function sessionRecord(
  runtime: WorktreeRuntime,
  sessionId: string,
  resumeState: HarnessAgentResumeSessionState,
): NativeChatSessionRecord {
  return {
    version: 1,
    vendor: runtime.vendor,
    purpose: runtime.purpose,
    worktree: runtime.worktree,
    sessionId,
    resumeState,
    ...(runtime.model ? { model: runtime.model } : {}),
    ...(runtime.modelEffort ? { modelEffort: runtime.modelEffort } : {}),
    updatedAt: new Date().toISOString(),
  }
}

async function parkRuntimeSession(runtime: WorktreeRuntime): Promise<NativeChatSessionRecord | undefined> {
  const session = runtime.session
  runtime.session = undefined
  if (!session) return undefined
  try {
    const resumeState = await session.stop()
    const record = sessionRecord(runtime, session.sessionId, resumeState)
    writeNativeChatSession(record)
    return record
  } catch (err) {
    clearNativeChatSession(sessionRef(runtime))
    console.error(`[kobe ai-sdk] failed to park runtime session for ${runtime.worktree}:`, err)
    await session.destroy().catch((destroyErr) => {
      console.error(`[kobe ai-sdk] failed to destroy unparked runtime session for ${runtime.worktree}:`, destroyErr)
    })
    return undefined
  }
}

async function ensureRuntimeSession(runtime: WorktreeRuntime): Promise<{
  readonly session: HarnessSession
  readonly shouldBridgeHistory: boolean
}> {
  if (runtime.session) return { session: runtime.session, shouldBridgeHistory: false }
  const stored = readNativeChatSession(sessionRef(runtime))
  if (stored) {
    try {
      runtime.session = await runtime.agent.createSession({
        sessionId: stored.sessionId,
        resumeFrom: stored.resumeState,
      })
      return { session: runtime.session, shouldBridgeHistory: false }
    } catch (err) {
      clearNativeChatSession(sessionRef(runtime))
      console.error(`[kobe ai-sdk] failed to resume parked session for ${runtime.worktree}:`, err)
    }
  }
  runtime.session = await runtime.agent.createSession()
  return { session: runtime.session, shouldBridgeHistory: true }
}

export async function disposeAiSdkRuntime(worktree: string): Promise<void> {
  const pending: Promise<unknown>[] = []
  for (const [key, runtime] of runtimes) {
    if (runtime.worktree !== worktree) continue
    runtimes.delete(key)
    pending.push(parkRuntimeSession(runtime))
  }
  await Promise.all(pending)
}

export interface AiSdkTurnOpts {
  readonly worktree: string
  readonly vendor?: VendorId
  readonly purpose?: AiSdkRuntimePurpose
  readonly model?: string
  readonly modelEffort?: string
  readonly history?: readonly AiSdkConversationMessage[]
  readonly historyTokenBudget?: number
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
    // ensureRuntime builds the harness synchronously (createHarness can throw on
    // a bad model id / validation) — keep it inside the async body so setup
    // failures resolve as a turn error, never an unhandled rejection.
    let runtime: WorktreeRuntime
    try {
      runtime = await ensureRuntime({
        vendor: resolveAiSdkHarnessVendor(opts.vendor),
        purpose: opts.purpose,
        worktree: opts.worktree,
        model: opts.model,
        modelEffort: opts.modelEffort,
      })
    } catch (e) {
      return { error: { message: getErrorMessage(e) } }
    }
    if (runtime.busy) return { error: { code: "runtimeBusy" } }
    runtime.busy = true
    let error: AiSdkTurnError | undefined
    try {
      const { session, shouldBridgeHistory } = await ensureRuntimeSession(runtime)
      const result = await runtime.agent.stream({
        session,
        prompt: shouldBridgeHistory
          ? buildPromptWithHistory(opts.prompt, opts.history, { historyTokenBudget: opts.historyTokenBudget })
          : opts.prompt,
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
