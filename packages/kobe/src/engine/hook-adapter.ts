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
 * Claude + Codex are real implementations (both use the same settings.json hook
 * shape, shared in `./json-hooks`); Copilot is a stub until its hook format is
 * wired (the interface is what keeps that change local).
 */

import type { VendorId } from "../types/vendor.ts"
import type { EngineActivityDetail, EngineActivityKind } from "./hook-events.ts"
import { engineEntry } from "./registry.ts"

export interface EngineHookAdapter {
  readonly vendor: VendorId
  /** Whether this engine has a wired hook mechanism (false → install is a no-op). */
  supportsHooks(): boolean
  /**
   * The engine's GLOBAL hook settings file (`~/.claude/settings.json` for
   * Claude, `~/.codex/hooks.json` for Codex) — the path the install/remove
   * methods write. The adapter owns this because the file lives in the engine's
   * own config dir, not kobe's. Only consulted when {@link supportsHooks} is
   * true; a no-op adapter may return "".
   */
  globalSettingsPath(): string
  /**
   * FIRE-time half of the adapter's translation (install time maps vendor
   * hook events to neutral verbs; this maps the vendor's stdin payload to
   * the neutral {@link EngineActivityDetail}). Returns undefined when the
   * payload carries nothing this verb needs — or when the payload isn't
   * this engine's (the installed hook command carries no vendor id, so
   * `kobe hook` asks each hook-supporting adapter in turn and uses the
   * first non-undefined answer). Pure; must never throw.
   */
  activityDetailFromPayload(
    kind: EngineActivityKind,
    payload: Record<string, unknown>,
  ): EngineActivityDetail | undefined
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
   * Whether this engine ever installed a worktree-sync (`WorktreeCreate`) hook —
   * used now only to know whose hook needs CLEANUP. The hook itself is removed:
   * `WorktreeCreate` is a VCS *provider* hook, so installing kobe's observer
   * broke `claude --worktree` / `EnterWorktree` everywhere. Sync moved to the
   * daemon (auto-adopt a worktree under a tracked repo on session-start).
   */
  supportsWorktreeSync(): boolean
  /** Remove the old kobe `WorktreeCreate` hook from a settings file. Idempotent +
   *  merge-safe (preserves the user's own WorktreeCreate hooks). No-op when
   *  unsupported. */
  removeWorktreeSyncHook(settingsFilePath: string): Promise<void>

  /**
   * Install the global worktree-WATCH hook: a creation-time observer that, the
   * moment a `git worktree add` runs in ANY engine session, adopts the new
   * worktree as a kobe task so it appears in the sidebar WITHOUT a running
   * session. Unlike the removed `WorktreeCreate` provider hook, this is a pure
   * OBSERVER fired AFTER the tool runs (Claude Code's `PostToolUse`), so its
   * presence never changes git/`--worktree` behaviour. Must be IDEMPOTENT,
   * merge-safe, and never throw fatally. No-op when {@link supportsHooks} is
   * false.
   */
  installWorktreeWatchHook(settingsFilePath: string): Promise<void>
  /** Remove the worktree-watch hook this adapter installed. Idempotent + merge-safe. */
  removeWorktreeWatchHook(settingsFilePath: string): Promise<void>
}

/**
 * Resolve the hook adapter for a vendor — a thin delegate to the engine
 * registry, which owns the claude-vs-noop choice (one entry per engine;
 * see `registry.ts`). Kept exported here so call sites (`cli/hook-cmd.ts`)
 * keep their import. NB: registry.ts imports `NoopHookAdapter` from this
 * module, so this pair is an intentional import cycle — both sides only
 * dereference the other's bindings inside function bodies (never at module
 * top-level), which keeps the cycle safe under ESM evaluation order.
 */
export function createEngineHookAdapter(vendor: VendorId): EngineHookAdapter {
  return engineEntry(vendor).createHookAdapter()
}

/** Stub for engines whose hook mechanism isn't wired yet (Codex, Copilot). */
export class NoopHookAdapter implements EngineHookAdapter {
  constructor(readonly vendor: VendorId) {}
  supportsHooks(): boolean {
    return false
  }
  globalSettingsPath(): string {
    return "" // no wired hooks → never consulted
  }
  activityDetailFromPayload(): EngineActivityDetail | undefined {
    return undefined // no wired hooks → no payload this adapter understands
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
  async removeWorktreeSyncHook(): Promise<void> {
    /* no-op */
  }
  async installWorktreeWatchHook(): Promise<void> {
    /* no-op until this engine's hook format is implemented */
  }
  async removeWorktreeWatchHook(): Promise<void> {
    /* no-op */
  }
}
