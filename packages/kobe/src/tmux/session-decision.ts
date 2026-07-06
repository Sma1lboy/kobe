export interface ObservedSession {
  readonly worktree: string
  readonly vendor: string
  readonly claudePaneAlive: boolean
  readonly windowCount: number
}

export interface TargetSession {
  readonly cwd: string
  readonly vendor?: string
  readonly hasEngineCommand: boolean
}

export type SessionAction =
  | { readonly kind: "create"; readonly reason: string }
  | { readonly kind: "reuse"; readonly reason: string }
  | { readonly kind: "respawn-engine"; readonly reason: string }
  | { readonly kind: "rebuild"; readonly reason: string }

export function decideSessionAction(observed: ObservedSession | null, target: TargetSession): SessionAction {
  if (observed === null) {
    return { kind: "create", reason: "no session with this name — build fresh" }
  }

  const worktreeOk = observed.worktree === target.cwd
  const vendorOk = !target.vendor || observed.vendor === target.vendor

  if (observed.claudePaneAlive && worktreeOk && vendorOk) {
    return { kind: "reuse", reason: "healthy: engine pane alive, worktree + vendor match" }
  }

  if (worktreeOk && !vendorOk && target.hasEngineCommand) {
    return {
      kind: "respawn-engine",
      reason:
        `vendor drift: session tagged ${observed.vendor === "" ? "<untagged>" : `"${observed.vendor}"`}, ` +
        `task wants "${target.vendor}" — relaunch engine pane in place (KOB-232)`,
    }
  }

  if (worktreeOk && vendorOk && observed.windowCount > 1) {
    return {
      kind: "reuse",
      reason: "active window's engine pane is gone but sibling chat tabs exist — reuse rather than drop them",
    }
  }

  if (!worktreeOk) {
    return {
      kind: "rebuild",
      reason:
        observed.worktree === ""
          ? "legacy session with no @kobe_worktree tag — rebuild in the right place"
          : `worktree drift: session tagged "${observed.worktree}", task wants "${target.cwd}" — rebuild`,
    }
  }
  if (!vendorOk) {
    return {
      kind: "rebuild",
      reason: "vendor drift but no engine command to respawn with — rebuild",
    }
  }
  return {
    kind: "rebuild",
    reason: "single-window session whose engine pane was destroyed — rebuild",
  }
}
