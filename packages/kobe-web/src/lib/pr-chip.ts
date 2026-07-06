import type { TaskPRStatus } from "./types.ts"

export interface PrChipView {
  label: string
  cls: string
  title: string
}

export function prChipView(pr: TaskPRStatus | undefined): PrChipView | null {
  const lifecycle = pr?.lifecycle
  if (!pr || !lifecycle || lifecycle === "unknown") return null
  const check = pr.checkState
  const cls =
    lifecycle === "merged"
      ? "text-kobe-violet"
      : lifecycle === "closed"
        ? "text-kobe-red"
        : check === "failing"
          ? "text-kobe-red"
          : check === "passing"
            ? "text-kobe-green"
            : check === "pending"
              ? "text-kobe-yellow"
              : "text-kobe-blue"
  return {
    label: pr.number ? `PR #${pr.number}` : "PR",
    cls,
    title: `${lifecycle}${check && check !== "none" ? ` · ${check}` : ""}`,
  }
}
