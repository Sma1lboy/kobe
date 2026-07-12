/**
 * Shared types for `kobe api` — flag specs, the verb contract, and the
 * side-effect seams (`ApiRuntime`, `PromptDeliveryOps`) handlers run
 * against. Split out of `api-cmd.ts` (see that file's header) so each verb
 * module can depend on the contract without pulling in the dispatcher.
 */

import type { VendorId } from "../../types/vendor.ts"
import type { DaemonRpc } from "../daemon-session.ts"
import type { VerbArgs } from "./flags.ts"

export type Flags = Map<string, string>

export interface ParsedArgs {
  readonly flags: Flags
  readonly pretty: boolean
  readonly help: boolean
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** Extra context merged into the error JSON — e.g. `taskId` when a
     *  create succeeded but delivery failed, so a script doesn't lose the
     *  already-created (engine-burning) task. */
    readonly data?: Record<string, unknown>,
  ) {
    super(message)
  }
}

// ── Declarative verb + flag specs (single source of truth) ───────────────────

export type FlagType = "string" | "int" | "bool" | "enum" | "csv"

export interface FlagSpec {
  readonly name: string
  readonly type: FlagType
  readonly required?: boolean
  readonly description: string
  /** Allowed values when `type === "enum"`. */
  readonly values?: readonly string[]
  /** Default shown in schema/help (informational; not auto-applied). */
  readonly default?: string
  /** Metavar for help/schema, e.g. PATH / ID / TEXT. */
  readonly placeholder?: string
}

/**
 * What a verb handler runs against. Everything here is injectable so a
 * handler's LOGIC is unit-testable without a daemon or PTY Host socket:
 * `client` accepts any {@link DaemonRpc} (tests pass a fake that
 * records requests), `runtime` carries the side-effecting operations
 * (tmux liveness, prompt delivery, git worktree reads).
 */
export interface VerbContext {
  /** Spec-typed flag access — coercion + requiredness derived from the verb's own {@link FlagSpec}s. */
  readonly args: VerbArgs
  /** Daemon RPC surface; `null` only for `offline` verbs (guard with `daemonOf`). */
  readonly client: DaemonRpc | null
  /** Side-effect seam (hosted sessions / git) — swapped for a fake in unit tests. */
  readonly runtime: ApiRuntime
}

export type VerbHandler = (ctx: VerbContext) => Promise<unknown>

export interface VerbSpec {
  readonly name: string
  readonly summary: string
  readonly flags: readonly FlagSpec[]
  /** Verbs that don't need the daemon (e.g. `schema`). */
  readonly offline?: boolean
  readonly handler: VerbHandler
}

// ── Prompt delivery (shared by add / fan-out / send) ─────────────────────────

export interface PromptTarget {
  readonly id: string
  readonly worktreePath: string
  readonly kind?: "main" | "task"
  readonly vendor?: VendorId
  readonly modelEffort?: string
  readonly repo?: string
}

export interface DeliveredPrompt {
  readonly session: string
  readonly pane: string
  readonly started: boolean
  readonly engineReady: boolean
  /**
   * Whether the paste was CONFIRMED in the engine's composer (its tail
   * appeared on capture). `false` on a cold boot where the pane never
   * settled — surfaced so a scripted fan-out's dropped first prompt never
   * looks like a clean success.
   */
  readonly delivered: boolean
}

/** Hosted prompt delivery seam, injectable for handler/unit tests. */
export interface PromptDeliveryOps {
  deliverHosted(target: PromptTarget, worktree: string, prompt: string): Promise<DeliveredPrompt>
}

// ── Runtime (the side-effect seam handlers run against) ─────────────────────

/**
 * Everything a verb handler touches BESIDES the daemon RPC: tmux session
 * liveness, prompt delivery, git worktree reads. The default implementation
 * (in `runtime.ts`) is the real thing (lazy-importing the heavier modules);
 * unit tests swap in fakes so handler logic runs without a daemon, tmux, or
 * git.
 */
export interface ApiRuntime {
  /** True iff the task's tmux session is live. */
  isTaskRunning(taskId: string): Promise<boolean>
  /** Deliver a prompt into a task's engine pane (building the session if needed). */
  deliverPrompt(client: DaemonRpc, target: PromptTarget, prompt: string): Promise<DeliveredPrompt>
  /** Canonical source repo for task creation and grouping. */
  resolveRepoRoot(absPath: string): Promise<string>
  /** Preferred engine for new tasks in `repo`; undefined delegates to daemon defaults. */
  defaultVendor(repo?: string): Promise<VendorId | undefined>
  /** Uncommitted +/− counts for a worktree. */
  readWorktreeChanges(worktreePath: string): Promise<{ added: number; deleted: number }>
  /**
   * Stop and kill a task's tmux session (and its engine), mirroring the TUI's
   * delete/archive teardown. The daemon must NOT touch tmux (it never imports
   * it), so the CLI process owns this teardown — run only AFTER the matching
   * `task.delete`/`task.archive` RPC succeeds. `switchClientBeforeKill` no-ops
   * outside tmux (the CLI is rarely attached); `killSession` no-ops when the
   * session isn't live. Best-effort: a teardown failure must not fail the
   * already-committed RPC, so it never throws.
   */
  tearDownSession(taskId: string): Promise<void>
}
