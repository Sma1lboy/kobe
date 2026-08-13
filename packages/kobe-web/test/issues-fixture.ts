import type { Issue } from "../src/lib/issues.ts"

export function issue(over: Partial<Issue>): Issue {
  return {
    id: over.id ?? 1,
    title: "",
    status: "open",
    created: "2026-06-01",
    body: "",
    ...over,
  }
}
