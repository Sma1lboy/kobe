/**
 * OpenRouter model metadata fallback.
 *
 * Codex app-server exposes the real `modelContextWindow` at runtime, but
 * `codex exec --json` drops it. OpenRouter's public Models API exposes a
 * `context_length` field for OpenAI model ids, so we use it as a best-effort
 * denominator only. The numerator is still kobe-estimated from visible chat
 * rows until kobe speaks Codex app-server directly.
 */

export interface OpenRouterModelMeta {
  readonly id: string
  readonly contextLength: number
}

const MODELS_URL = "https://openrouter.ai/api/v1/models"
const FETCH_TIMEOUT_MS = 2500

let cachePromise: Promise<Map<string, OpenRouterModelMeta>> | undefined

export async function resolveOpenRouterContextWindow(modelId: string | undefined): Promise<number | undefined> {
  const id = openRouterModelId(modelId)
  if (!id) return undefined
  const models = await loadOpenRouterModels()
  return models.get(id)?.contextLength
}

export function openRouterModelId(modelId: string | undefined): string | null {
  const id = modelId?.trim()
  if (!id) return null
  return id.includes("/") ? id : `openai/${id}`
}

export function _resetOpenRouterModelCacheForTests(): void {
  cachePromise = undefined
}

async function loadOpenRouterModels(): Promise<Map<string, OpenRouterModelMeta>> {
  cachePromise ??= fetchOpenRouterModels().catch(() => new Map())
  return cachePromise
}

async function fetchOpenRouterModels(): Promise<Map<string, OpenRouterModelMeta>> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const res = await fetch(MODELS_URL, {
    signal,
    headers: { "user-agent": "kobe-codex-openrouter-context" },
  })
  if (!res.ok) return new Map()
  const body = (await res.json()) as unknown
  if (!isObject(body) || !Array.isArray(body.data)) return new Map()

  const out = new Map<string, OpenRouterModelMeta>()
  for (const item of body.data) {
    if (!isObject(item)) continue
    const id = typeof item.id === "string" ? item.id : undefined
    const contextLength = typeof item.context_length === "number" ? item.context_length : undefined
    if (!id || !contextLength || !Number.isFinite(contextLength) || contextLength <= 0) continue
    out.set(id, { id, contextLength })
  }
  return out
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
