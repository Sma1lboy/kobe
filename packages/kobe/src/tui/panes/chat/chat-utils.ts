import type { ChatRow } from "./store"

export function estimateContextTokensFromRows(rows: readonly ChatRow[]): number {
  let chars = 0
  for (const row of rows) {
    switch (row.kind) {
      case "user":
      case "assistant":
      case "system":
        chars += row.text.length
        break
      case "tool":
        chars += row.name.length
        chars += stringifyForTokenEstimate(row.input).length
        chars += stringifyForTokenEstimate(row.output).length
        break
      case "approval":
        chars += row.tool.length + row.plan.length
        break
      case "question":
        chars += row.questions.reduce((total, q) => total + q.question.length, 0)
        break
    }
  }
  return Math.max(1, Math.round(chars / 4))
}

function stringifyForTokenEstimate(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err) ?? String(err)
  } catch {
    return String(err)
  }
}
