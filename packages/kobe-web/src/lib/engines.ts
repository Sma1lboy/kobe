import { api } from "./api-client.ts"
import { createExternalStore } from "./external-store.ts"

export interface EngineOption {
  id: string
  label: string
  effortLevels?: readonly string[]
}

const FALLBACK: readonly EngineOption[] = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
]

const store = createExternalStore<readonly EngineOption[]>(FALLBACK)
let fetched = false

function ensureFetched(): void {
  if (fetched) return
  fetched = true
  void api
    .getOr<{ engines?: EngineOption[] }>(
      "/api/engines",
      {},
      { label: "load engines" },
    )
    .then((json) => {
      if (!Array.isArray(json.engines) || json.engines.length === 0) return
      store.replace(
        json.engines
          .filter(
            (e): e is EngineOption =>
              typeof e?.id === "string" && typeof e?.label === "string",
          )
          .map((e) => ({
            id: e.id,
            label: e.label,
            ...(Array.isArray(e.effortLevels) &&
            e.effortLevels.every((l) => typeof l === "string")
              ? { effortLevels: e.effortLevels }
              : {}),
          })),
      )
    })
    .catch(() => {})
}

export function useEngines(): readonly EngineOption[] {
  ensureFetched()
  return store.useSnapshot()
}
