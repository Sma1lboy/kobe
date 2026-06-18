import { lazy, type ReactNode, Suspense } from "react"

export const LazyIssueIntakePanel = lazy(() =>
  import("./IssueIntakePanel.tsx").then((module) => ({
    default: module.IssueIntakePanel,
  })),
)

export const LazyIssuePeek = lazy(() =>
  import("./IssuePeek.tsx").then((module) => ({ default: module.IssuePeek })),
)

export function IssuePanelSuspense({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="fixed inset-0 z-40 flex justify-end">
          <div className="relative flex h-full w-[640px] max-w-[92vw] items-center justify-center border-l border-line bg-bg text-[12px] text-subtle shadow-2xl">
            Loading…
          </div>
        </div>
      }
    >
      {children}
    </Suspense>
  )
}
