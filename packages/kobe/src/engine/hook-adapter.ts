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
 * the GLOBAL activity hooks once, and the adapter writes whatever its engine
 * reads, pointing each hook at `kobe hook <normalized-verb>` (see
 * {@link ./hook-events}). The hook reports its `cwd`; the daemon maps that to a
 * task (`daemon/cwd-task.ts`). Adding a new engine = a new adapter file; no
 * neutral code changes.
 *
 * Claude is the first real implementation; Codex/Copilot are stubs until their
 * hook formats are wired (the interface is what keeps that change local).
 */

import type { VendorId } from "../types/vendor.ts"
import { ClaudeHookAdapter } from "./claude-code-local/hook-adapter.ts"

export interface EngineHookAdapter {
  readonly vendor: VendorId
  /** Whether this engine has a wired hook mechanism (false → install is a no-op). */
  supportsHooks(): boolean
  /**
   * Install kobe's activity hooks into a SHARED settings file (the user's
   * global `~/.claude/settings.json`) so the engine, in ANY session, reports
   * normalized events via `kobe hook <verb>` (cwd-based; the daemon maps cwd to
   * a task). Must be IDEMPOTENT (safe on every launch; skips the write when
   * already in place), merge-safe (preserves the user's own hooks), and must
   * never throw fatally.
   */
  installActivityHooks(settingsFilePath: string): Promise<void>
  /** Remove the activity hooks this adapter installed. Idempotent. */
  removeActivityHooks(settingsFilePath: string): Promise<void>

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
  async installActivityHooks(): Promise<void> {
    /* no-op until this engine's hook format is implemented */
  }
  async removeActivityHooks(): Promise<void> {
    /* no-op */
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
