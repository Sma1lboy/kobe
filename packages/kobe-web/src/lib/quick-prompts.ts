import { api } from "./api-client.ts"

export interface QuickPrompts {
  review: string | null
  pr: string | null
}

export async function fetchQuickPrompts(): Promise<QuickPrompts> {
  const json = await api.getOr<Partial<QuickPrompts>>(
    "/api/quick-prompts",
    {},
    { label: "load quick prompts" },
  )
  return {
    review: typeof json.review === "string" ? json.review : null,
    pr: typeof json.pr === "string" ? json.pr : null,
  }
}

export async function saveQuickPrompts(prompts: {
  review: string
  pr: string
}): Promise<void> {
  await api.put<void>("/api/quick-prompts", prompts, {
    label: "save quick prompts",
  })
}
