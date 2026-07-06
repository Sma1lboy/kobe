import type { ModelChoice } from "@/types/engine"
import type { VendorId } from "@/types/vendor"
import type { UIMessage } from "ai"
import { type AiSdkConversationMessage, startAiSdkTurn } from "./harness-turn"

export type TurnModelChoice = Pick<ModelChoice, "vendor" | "id" | "effort"> | undefined

export interface ModelRouterChoice {
  readonly id: string
  readonly effort?: string
}

export interface SmallModelRouteRequest {
  readonly vendor: VendorId
  readonly routerModel?: string | undefined
  readonly prompt: string
  readonly history: readonly AiSdkConversationMessage[]
  readonly candidates: readonly ModelChoice[]
  readonly current: TurnModelChoice
}

export type CallSmallModelForRoute = (
  request: SmallModelRouteRequest,
) => Promise<string | ModelRouterChoice | undefined>

export interface ChooseTurnModelOpts {
  readonly vendor: VendorId
  readonly prompt: string
  readonly history: readonly AiSdkConversationMessage[]
  readonly current: TurnModelChoice
  readonly capabilities:
    | {
        readonly models: readonly ModelChoice[]
        defaultModelId(): string
        smallFastModelId?(): string | undefined
      }
    | undefined
  readonly autoModelEnabled: boolean
  readonly callSmallModel?: CallSmallModelForRoute
}

export interface AiSdkModelRouterCallOpts extends SmallModelRouteRequest {
  readonly worktree: string
}

function sameProviderCandidates(vendor: VendorId, models: readonly ModelChoice[]): readonly ModelChoice[] {
  return models.filter((model) => model.vendor === vendor)
}

function fallbackChoice(opts: ChooseTurnModelOpts, candidates: readonly ModelChoice[]): TurnModelChoice {
  if (opts.current?.vendor === opts.vendor) return opts.current
  const defaultId = opts.capabilities?.defaultModelId()
  const defaultChoice =
    candidates.find((model) => model.id === defaultId && model.effort === undefined) ?? candidates[0]
  return defaultChoice
    ? { vendor: defaultChoice.vendor, id: defaultChoice.id, effort: defaultChoice.effort }
    : undefined
}

function matchingCandidate(
  vendor: VendorId,
  candidates: readonly ModelChoice[],
  choice: ModelRouterChoice | undefined,
): ModelChoice | undefined {
  if (!choice?.id) return undefined
  const sameId = candidates.filter((model) => model.vendor === vendor && model.id === choice.id)
  if (sameId.length === 0) return undefined
  if (choice.effort === undefined)
    return sameId.length === 1 ? sameId[0] : sameId.find((model) => model.effort === undefined)
  return sameId.find((model) => model.effort === choice.effort)
}

function asTurnChoice(model: ModelChoice | undefined): TurnModelChoice {
  return model ? { vendor: model.vendor, id: model.id, effort: model.effort } : undefined
}

export function parseModelRouterChoice(raw: string | ModelRouterChoice | undefined): ModelRouterChoice | undefined {
  if (!raw) return undefined
  if (typeof raw !== "string") return raw.id.trim() ? raw : undefined
  const text = raw.trim()
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === "object") {
      const obj = parsed as { id?: unknown; model?: unknown; effort?: unknown }
      const id = typeof obj.model === "string" ? obj.model : typeof obj.id === "string" ? obj.id : undefined
      const effort = typeof obj.effort === "string" ? obj.effort : undefined
      return id?.trim() ? { id: id.trim(), ...(effort?.trim() ? { effort: effort.trim() } : {}) } : undefined
    }
  } catch {
    // Plain model ids are accepted below.
  }
  const match = text.match(/(?:model|id)\s*[:=]\s*([A-Za-z0-9_.:/@-]+)/i)
  return { id: (match?.[1] ?? text.split(/\s+/)[0] ?? "").trim() }
}

export function buildModelRouterPrompt(request: SmallModelRouteRequest): string {
  const candidates = request.candidates
    .map((model) => `- ${model.id}${model.effort ? ` effort=${model.effort}` : ""}: ${model.label}`)
    .join("\n")
  const history = request.history
    .slice(-8)
    .map((msg) => `${msg.role === "assistant" ? "Assistant" : "User"}: ${msg.text}`)
    .join("\n")
  return [
    "Choose the best model for the next turn.",
    'Return only compact JSON: {"model":"<id>","effort":"<effort>"}. Omit effort when not needed.',
    `Provider: ${request.vendor}`,
    `Current model: ${request.current?.id ?? "(default)"}`,
    "Allowed candidates:",
    candidates,
    history ? `Recent conversation:\n${history}` : "Recent conversation: (none)",
    `Next user prompt:\n${request.prompt}`,
  ].join("\n\n")
}

function uiMessageText(msg: UIMessage | undefined): string | undefined {
  const text = msg?.parts
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text.trim() : ""))
    .filter(Boolean)
    .join("\n")
  return text || undefined
}

export async function callAiSdkModelRouter(opts: AiSdkModelRouterCallOpts): Promise<string | undefined> {
  let latest: UIMessage | undefined
  const turn = startAiSdkTurn({
    worktree: opts.worktree,
    vendor: opts.vendor,
    purpose: "router",
    model: opts.routerModel,
    prompt: buildModelRouterPrompt(opts),
    onUpdate: (msg) => {
      latest = msg
    },
  })
  const { error } = await turn.done
  if (error) return undefined
  return uiMessageText(latest)
}

export async function chooseTurnModel(opts: ChooseTurnModelOpts): Promise<TurnModelChoice> {
  const candidates = sameProviderCandidates(opts.vendor, opts.capabilities?.models ?? [])
  const fallback = fallbackChoice(opts, candidates)
  if (!opts.autoModelEnabled || candidates.length <= 1 || !opts.callSmallModel) return fallback
  const routerModel = opts.capabilities?.smallFastModelId?.() ?? opts.capabilities?.defaultModelId()
  let raw: string | ModelRouterChoice | undefined
  try {
    raw = await opts.callSmallModel({
      vendor: opts.vendor,
      routerModel,
      prompt: opts.prompt,
      history: opts.history,
      candidates,
      current: opts.current,
    })
  } catch {
    return fallback
  }
  const match = matchingCandidate(opts.vendor, candidates, parseModelRouterChoice(raw))
  return asTurnChoice(match) ?? fallback
}
