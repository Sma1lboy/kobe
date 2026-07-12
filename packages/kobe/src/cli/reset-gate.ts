/**
 * Breaking-version reset gate.
 *
 * `state.json` remembers the last version that ran (`app.lastRunVersion`).
 * When the running binary and that stamp sit on opposite sides of a
 * version in {@link BREAKING_VERSIONS}, the on-disk daemon/task/UI state
 * may be incompatible — so the app entrances (default TUI, `kobe web`)
 * refuse to start until the user runs `kobe reset`, which tears down the
 * daemon/PTY host/sessions and re-stamps the gate.
 *
 * Deliberately NOT enforced for non-app subcommands (`update`, `doctor`,
 * `reset` itself, `api`, …): the user must always be able to inspect and
 * recover a gated install.
 */

import { loadStateFile, patchStateFile } from "../state/store.ts"
import { BREAKING_VERSIONS, CURRENT_VERSION, compareSemver } from "../version.ts"

export const LAST_RUN_VERSION_KEY = "app.lastRunVersion"

/**
 * Pure decision: the breaking versions blocking a start, given the stored
 * stamp. A missing/non-string stamp is a fresh install (or a pre-gate
 * build's state) — nothing to block, the caller stamps and proceeds.
 * Direction-agnostic, same rule as {@link breakingVersionsCrossed}.
 */
export function resetGateBlockers(
  lastRun: unknown,
  current: string = CURRENT_VERSION,
  breaking: readonly string[] = BREAKING_VERSIONS,
): string[] {
  if (typeof lastRun !== "string" || lastRun.length === 0) return []
  const [lo, hi] = compareSemver(lastRun, current) <= 0 ? [lastRun, current] : [current, lastRun]
  return breaking.filter((b) => compareSemver(b, lo) > 0 && compareSemver(b, hi) <= 0)
}

/**
 * Enforce the gate at an app entrance: exit(1) with instructions when a
 * breaking version was crossed since the last run, otherwise re-stamp the
 * current version (best-effort) and return.
 */
export function enforceResetGate(): void {
  const lastRun = loadStateFile()[LAST_RUN_VERSION_KEY]
  const blockers = resetGateBlockers(lastRun)
  if (blockers.length > 0) {
    const from = typeof lastRun === "string" ? lastRun : "unknown"
    console.error(
      [
        `kobe ${CURRENT_VERSION}: cannot start — version ${blockers.join(", ")} introduced breaking changes`,
        `(last run: ${from}). Your daemon/session state may be incompatible.`,
        "",
        "Run:",
        "  kobe reset          # stop daemon + PTY host + sessions (tasks kept)",
        "  kobe reset --hard   # additionally wipe the task index + UI state",
        "",
        "Then relaunch kobe. Worktrees are never touched.",
      ].join("\n"),
    )
    process.exit(1)
  }
  if (lastRun !== CURRENT_VERSION) stampResetGate()
}

/**
 * Stamp the gate as satisfied for the running version. Called after a pass
 * and by `kobe reset` on completion (which is what clears a block).
 * Best-effort: a read-only FS must not turn the stamp into a crash.
 */
export function stampResetGate(): void {
  try {
    patchStateFile({ [LAST_RUN_VERSION_KEY]: CURRENT_VERSION })
  } catch {
    // Never block startup on a failed stamp — the gate just re-evaluates next run.
  }
}
