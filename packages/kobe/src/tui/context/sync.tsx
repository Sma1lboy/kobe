/**
 * Sync store (empty stub).
 *
 * Opencode's `useSync` is the reactive mirror of its server state — sessions,
 * messages, agents, providers, MCP, LSP, vcs, etc. — all populated by SDK
 * calls and event subscriptions. kobe's orchestrator uses its own reactive
 * pattern instead; this shim exists so any lifted opencode component that
 * imports `@tui/context/sync` typechecks and renders without modification.
 * Every accessor returns an empty array / undefined / "complete" — the
 * equivalent of "nothing happening, but loading is done."
 */

import { createSimpleContext } from "./helper"

export type Status = "loading" | "partial" | "complete"

export type SyncStore = {
  /** When kobe wires real state this becomes the reactive root. */
  data: {
    session: unknown[]
    message: Record<string, unknown[]>
    part: Record<string, unknown[]>
    todo: Record<string, unknown[]>
    permission: Record<string, unknown[]>
    question: Record<string, unknown[]>
    config: Record<string, unknown>
  }
  status: Status
  ready: boolean
}

const EMPTY: SyncStore["data"] = {
  session: [],
  message: {},
  part: {},
  todo: {},
  permission: {},
  question: {},
  config: {},
}

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const result = {
      data: EMPTY,
      get status(): Status {
        return "complete"
      },
      get ready(): boolean {
        return true
      },
      session: {
        get(_id: string): unknown {
          return undefined
        },
        async refresh(): Promise<void> {
          /* no-op */
        },
        status(_id: string): "idle" | "working" | "compacting" {
          return "idle"
        },
        async sync(_id: string): Promise<void> {
          /* no-op */
        },
      },
      async bootstrap(): Promise<void> {
        /* no-op */
      },
    }
    return result
  },
})

export type SyncContext = ReturnType<typeof useSync>
