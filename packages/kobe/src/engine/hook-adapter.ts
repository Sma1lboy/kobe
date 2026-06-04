/**
 * Engine HOOK adapter — the neutral seam (KOB).
 *
 * kobe wants engine activity (turn started/finished, rate-limited, waiting on
 * a permission prompt) to flow as real events, not polling. Each engine
 * delivers that through its OWN hook mechanism — Claude Code's
 * `.claude/settings.json` hooks, Codex's `hooks.json`, etc. — which are
 * vendor-specific. This interface hides ALL of that behind a neutral contract
 * so the orchestrator / daemon / TUI never name a vendor (CLAUDE.md
 * "Engine-owned UI data"): the orchestrator just asks the adapter to install
 * the per-task hooks into a worktree, and the adapter writes whatever its
 * engine reads, pointing each hook at `kobe hook <normalized-verb>` (see
 * {@link ./hook-events}). Adding a new engine = a new adapter file; no neutral
 * code changes.
 *
 * Claude is the first real implementation; Codex/Copilot are stubs until their
 * hook formats are wired (the interface is what keeps that change local).
 */

import type { VendorId } from "../types/vendor.ts"
import { ClaudeHookAdapter } from "./claude-code-local/hook-adapter.ts"

export interface HookInstallContext {
  /** Absolute path of the task's worktree (where engine config is written). */
  readonly worktreeDir: string
  /** The kobe task id baked into each hook so the daemon can map events back. */
  readonly taskId: string
}

export interface EngineHookAdapter {
  readonly vendor: VendorId
  /** Whether this engine has a wired hook mechanism (false → install is a no-op). */
  supportsHooks(): boolean
  /**
   * Install the per-task activity hooks into `ctx.worktreeDir` so the engine,
   * when it runs there, reports normalized events via `kobe hook …`. Must be
   * IDEMPOTENT (safe to call on every worktree (re)build) and must never throw
   * fatally — a hook-install failure must not block the task from launching.
   */
  installTaskHooks(ctx: HookInstallContext): Promise<void>

  /**
   * Whether this engine can create worktrees OUTSIDE kobe that kobe should
   * sync back (Claude Code's `claude --worktree`). Only such engines get a
   * worktree-sync hook installed by `kobe hook setup`.
   */
  supportsWorktreeSync(): boolean
  /**
   * Add a "worktree created" hook to a settings file (`~/.claude/settings.json`
   * global, or `<repo>/.claude/settings.json`) so an external worktree-create
   * pings `kobe hook worktree-created`. Idempotent + merge-safe (tags its own
   * entry, preserves the user's other hooks). No-op when unsupported.
   */
  installWorktreeSyncHook(settingsFilePath: string): Promise<void>
  /** Remove the worktree-sync hook this adapter installed. Idempotent. */
  removeWorktreeSyncHook(settingsFilePath: string): Promise<void>
}

/** Resolve the hook adapter for a vendor (mirrors createEngineTurnDetector). */
export function createEngineHookAdapter(vendor: VendorId): EngineHookAdapter {
  if (vendor === "claude") return new ClaudeHookAdapter()
  return new NoopHookAdapter(vendor)
}

/** Stub for engines whose hook mechanism isn't wired yet (Codex, Copilot). */
export class NoopHookAdapter implements EngineHookAdapter {
  constructor(readonly vendor: VendorId) {}
  supportsHooks(): boolean {
    return false
  }
  async installTaskHooks(): Promise<void> {
    /* no-op until this engine's hook format is implemented */
  }
  supportsWorktreeSync(): boolean {
    return false
  }
  async installWorktreeSyncHook(): Promise<void> {
    /* no-op */
  }
  async removeWorktreeSyncHook(): Promise<void> {
    /* no-op */
  }
}
