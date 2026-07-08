/**
 * Auto-name every ChatTab window from its own first prompt (KOB).
 *
 * Companion to the daemon's live task auto-title (`daemon/auto-title-poller.ts`).
 * Each ChatTab is a tmux window running its own engine session; for a claude
 * launch we force a known session id at spawn (`--session-id`) and stash it on
 * the window as `@kobe_session_id` (see `tui/panes/terminal/tmux.ts`). This
 * pass walks every task's windows, reads that id, derives the window's first
 * user prompt from THAT transcript, and renames the window to it — so a
 * Ctrl+T tab gets its own name, not the task's.
 *
 * Per window:
 *   - Skip if it was named manually. `rename-window` (and F2) flips a window's
 *     `automatic-rename` to `off`; an untouched window inherits the global
 *     `on`. So `automatic-rename off` == "already named" — our don't-clobber
 *     guard. The flag rides the window listing as the `#{automatic-rename}`
 *     OPTION-name format (hyphen — the `#{automatic_rename}` underscore
 *     variable doesn't exist and expands empty on tmux 3.5a), which resolves
 *     "1"/"0" through option inheritance; only the global-off corner needs a
 *     real `show-window-options` probe (see `runChatTabNamingPass`).
 *   - With a recorded session id → name from that session (claude tabs).
 *   - Without one, only the ORIGIN (lowest-index) window is named, from the
 *     task's first session — the codex/legacy fallback, since codex can't take
 *     a caller-set session id and pre-change windows have no id stashed.
 *
 * Self-limiting like the title poller: once a window is renamed its
 * automatic-rename is off, so later ticks skip it; windows with no prompt yet
 * derive `""` and stay until their first message lands.
 *
 * Dead-session backoff (daemon issue #27): a task with NO live tmux session
 * (never entered yet, or its session was killed/the tmux server restarted) is
 * a normal, common state — `ensureSession` only creates the session lazily
 * when the user first enters the task (`tui/lib/task-enter.ts`). So a
 * `list-windows` miss is NOT evidence of a bug; polling it at full cadence
 * FOREVER is. {@link nextChatTabPoll} tracks consecutive misses per task and
 * backs off exponentially (capped) the same way the PR-status poller backs
 * off a broken `gh` (`daemon/pr-status-collector.ts`) — never a permanent
 * evict, since the session can legitimately reappear (the user enters the
 * task later). One success (a `list-windows` that finds the session) resets
 * the streak to full cadence immediately.
 */

import { applyJitter, exponentialBackoff } from "@/lib/poll-scheduling"
import { deriveTitleFromSession, deriveTitleFromSessionId } from "@/monitor/auto-title"
import type { Orchestrator } from "@/orchestrator/core"
import { CHAT_TAB_SESSION_ID_OPTION, runTmux, runTmuxCapturing, tmuxSessionName } from "@/tmux/client"
import { DEFAULT_TASK_VENDOR, type VendorId } from "@/types/task"

/** Seam for tests — the real implementation shells `tmux` via the client. */
export interface TmuxRunner {
  capture(args: string[]): Promise<{ code: number; stdout: string }>
  run(args: string[]): Promise<number>
}

const realRunner: TmuxRunner = { capture: runTmuxCapturing, run: runTmux }

/** One ChatTab window: its tmux index and the engine session id stashed on it. */
export interface ChatTabWindow {
  readonly index: number
  /** `@kobe_session_id` value, or `""` when none was recorded (codex/legacy). */
  readonly sessionId: string
  /**
   * The window's EFFECTIVE `automatic-rename` as the `#{automatic-rename}`
   * format flag: `"1"` on, `"0"` off, `""` when the tmux can't expand
   * option names in formats. tmux resolves the flag through option
   * inheritance (local window value, else the global window option), so
   * `"1"` PROVES the local option isn't `off` (i.e. the window was never
   * manually named) without a per-window `show-window-options` spawn;
   * `"0"` is ambiguous when the user's tmux.conf sets the GLOBAL
   * automatic-rename off — the pass disambiguates with one global probe.
   */
  readonly autoRename: string
}

/**
 * List a session's windows with their recorded engine session id. `null`
 * when `list-windows` failed (almost always "can't find session" — the
 * session hasn't been created yet, or was killed/the tmux server
 * restarted); `[]` is reserved for a genuinely empty listing. Callers use
 * the `null`/`[]` split to drive the dead-session backoff — a `[]` never
 * happens in practice (a tmux session always has ≥1 window) but is kept
 * distinct so a future real-empty case doesn't get mistaken for a miss.
 */
export async function listChatTabWindows(
  session: string,
  runner: TmuxRunner = realRunner,
): Promise<ChatTabWindow[] | null> {
  const { code, stdout } = await runner.capture([
    "list-windows",
    "-t",
    `=${session}`,
    "-F",
    `#{window_index}\t#{automatic-rename}\t#{${CHAT_TAB_SESSION_ID_OPTION}}`,
  ])
  if (code !== 0) return null
  const out: ChatTabWindow[] = []
  for (const line of stdout.split("\n")) {
    const [indexField, autoRename, sessionId] = line.split("\t")
    const index = Number.parseInt((indexField ?? "").trim(), 10)
    if (!Number.isInteger(index)) continue
    out.push({ index, sessionId: sessionId?.trim() ?? "", autoRename: autoRename?.trim() ?? "" })
  }
  return out
}

/** True when a window was named manually (F2 / `-n`): its automatic-rename is off. */
async function windowNamedManually(session: string, index: number, runner: TmuxRunner): Promise<boolean> {
  const { code, stdout } = await runner.capture([
    "show-window-options",
    "-t",
    `=${session}:${index}`,
    "automatic-rename",
  ])
  return code === 0 && /\boff\b/.test(stdout)
}

/** True when the user's GLOBAL window automatic-rename is off (tmux.conf). */
async function globalAutomaticRenameOff(runner: TmuxRunner): Promise<boolean> {
  const { code, stdout } = await runner.capture(["show-window-options", "-g", "automatic-rename"])
  return code === 0 && /\boff\b/.test(stdout)
}

/** Rename one window. Returns true on success. */
async function renameWindow(session: string, index: number, title: string, runner: TmuxRunner): Promise<boolean> {
  return (await runner.run(["rename-window", "-t", `=${session}:${index}`, "--", title])) === 0
}

/** Injectable title derivers so the pass is testable without disk transcripts. */
export interface ChatTabNamingDeps {
  runner: TmuxRunner
  titleFromSessionId(vendor: VendorId, sessionId: string): Promise<string>
  titleFromWorktree(worktree: string, vendor: VendorId): Promise<string>
}

const realDeps: ChatTabNamingDeps = {
  runner: realRunner,
  titleFromSessionId: deriveTitleFromSessionId,
  titleFromWorktree: deriveTitleFromSession,
}

/** Re-poll cadence for a task whose session is present (matches the poller's tick). */
export const CHAT_TAB_LIVE_POLL_MS = 4_000
/** First backoff step once a session miss streak starts (doubles per consecutive miss). */
export const CHAT_TAB_MISS_BASE_MS = 4_000
/**
 * Cap on the miss backoff — a task with no session (never entered, or its
 * session was killed) settles here instead of `list-windows`-ing it every
 * tick forever. 30s: slow enough to stop the log/CPU flood, fast enough that
 * a user re-entering the task gets it auto-named again within half a minute.
 */
export const CHAT_TAB_MISS_CAP_MS = 30_000
/** Consecutive misses before backoff kicks in — one miss is noise (a session
 * mid-creation); three in a row is a task that genuinely has none right now. */
export const CHAT_TAB_MISS_THRESHOLD = 3

/** Per-task scheduling state: next-allowed-at + the consecutive-miss streak. */
export interface ChatTabPollEntry {
  readonly nextAllowedAt: number
  readonly misses: number
}

/** Per-task schedule, keyed by task id. Carried across passes by the live poller. */
export type ChatTabPollSchedule = Map<string, ChatTabPollEntry>

/**
 * Decide when a task's session may next be probed, given whether the latest
 * `list-windows` found the session. Pure + deterministic (inject `rand` for
 * tests). Mirrors `nextPrPoll`'s shape (`daemon/pr-status-collector.ts`):
 *   - found → reset the streak, full live cadence.
 *   - miss, streak still under {@link CHAT_TAB_MISS_THRESHOLD} → full cadence
 *     (a session mid-creation or a one-tick race shouldn't back off yet).
 *   - miss, streak at/over the threshold → exponential backoff capped at
 *     {@link CHAT_TAB_MISS_CAP_MS}, so a genuinely dead session stops being
 *     probed at full rate but is never evicted outright — the user re-entering
 *     the task later recreates the session and the next probe finds it.
 */
export function nextChatTabPoll(
  found: boolean,
  prevMisses: number,
  now: number,
  rand: () => number = Math.random,
): ChatTabPollEntry {
  if (found)
    return { nextAllowedAt: now + applyJitter(CHAT_TAB_LIVE_POLL_MS, CHAT_TAB_POLL_JITTER_RATIO, rand), misses: 0 }
  const misses = prevMisses + 1
  if (misses < CHAT_TAB_MISS_THRESHOLD) {
    return { nextAllowedAt: now + applyJitter(CHAT_TAB_LIVE_POLL_MS, CHAT_TAB_POLL_JITTER_RATIO, rand), misses }
  }
  const backoff = exponentialBackoff(CHAT_TAB_MISS_BASE_MS, misses - CHAT_TAB_MISS_THRESHOLD, CHAT_TAB_MISS_CAP_MS)
  return { nextAllowedAt: now + applyJitter(backoff, CHAT_TAB_POLL_JITTER_RATIO, rand), misses }
}

/** ± jitter ratio on the schedule delay (de-syncs many dead-session tasks coming due together). */
const CHAT_TAB_POLL_JITTER_RATIO = 0.2

/**
 * One pass: name every still-default ChatTab window across all tasks. Returns
 * the number of windows renamed (for tests). Best-effort per window — a tmux
 * or read failure on one window never blocks the others.
 *
 * `schedule` (optional) is the dead-session backoff state, carried across
 * passes by the live poller: a task whose session keeps missing is skipped
 * (no `list-windows` spawn) until its backoff elapses, and entries for tasks
 * no longer in `orch.listTasks()` (archived/deleted) are pruned up front —
 * archive/delete proactively drops the task from the poll set. Omitting it
 * (tests, one-shot callers) polls every eligible task every pass, same as
 * before this schedule existed.
 */
export async function runChatTabNamingPass(
  orch: Orchestrator,
  deps: ChatTabNamingDeps = realDeps,
  schedule?: ChatTabPollSchedule,
  now: number = Date.now(),
  rand: () => number = Math.random,
): Promise<number> {
  let renamed = 0
  // Manual-name guard, mostly free of tmux spawns. The flag carried by the
  // window listing already proves "never manually named" when it reads on
  // (`"1"`); a `"0"` only needs the per-window `show-window-options` probe
  // when the GLOBAL automatic-rename is off (then every window expands `"0"`
  // and the flag can't tell local-off from inherited-off). The global state
  // is probed lazily, at most ONCE per pass — so the steady state (all
  // windows named, global on) costs one list-windows per task and zero
  // per-window probes.
  let globalOff: boolean | null = null
  const manuallyNamed = async (session: string, w: ChatTabWindow): Promise<boolean> => {
    if (w.autoRename === "1") return false
    if (w.autoRename === "0") {
      if (globalOff === null) globalOff = await globalAutomaticRenameOff(deps.runner)
      if (!globalOff) return true
    }
    // Ambiguous (global off) or unexpandable flag — ask the window directly.
    return windowNamedManually(session, w.index, deps.runner)
  }
  const eligibleIds = new Set<string>()
  for (const task of orch.listTasks()) {
    // Archived tasks are settled — skip before the per-task `tmux list-windows`
    // shell-out + transcript reads, which otherwise ran every tick for every
    // archived task and scaled with the archive size. Un-archiving re-includes
    // the task on the next tick. Matches the sidebar's `t.archived` predicate.
    if (task.archived || task.kind === "main" || !task.worktreePath) continue
    eligibleIds.add(task.id)
    // Dead-session backoff gate: a task whose session has been missing for a
    // while is skipped entirely (no `list-windows` spawn) until its backoff
    // elapses — this is what stops daemon issue #27's tight per-tick
    // `list-windows` retry against a session that's gone for hours.
    const entry = schedule?.get(task.id)
    if (entry && now < entry.nextAllowedAt) continue
    const session = tmuxSessionName(task.id)
    const windows = await listChatTabWindows(session, deps.runner)
    if (windows === null) {
      schedule?.set(task.id, nextChatTabPoll(false, entry?.misses ?? 0, now, rand))
      continue
    }
    schedule?.set(task.id, nextChatTabPoll(true, entry?.misses ?? 0, now, rand))
    if (windows.length === 0) continue
    const originIndex = windows.reduce((min, w) => Math.min(min, w.index), Number.POSITIVE_INFINITY)
    const vendor = task.vendor ?? DEFAULT_TASK_VENDOR
    for (const w of windows) {
      try {
        if (await manuallyNamed(session, w)) continue
        const title = w.sessionId
          ? await deps.titleFromSessionId(vendor, w.sessionId)
          : w.index === originIndex
            ? await deps.titleFromWorktree(task.worktreePath, vendor)
            : ""
        if (title && (await renameWindow(session, w.index, title, deps.runner))) renamed++
      } catch {
        // best-effort: skip this window, keep going
      }
    }
  }
  // Proactive poll-set cleanup (daemon issue #27, req 2): a task that was
  // archived or deleted since the last pass drops out of `orch.listTasks()`
  // above, so it never re-adds itself to `eligibleIds` — forget its backoff
  // state here rather than let a stale entry sit in the map forever.
  if (schedule) {
    for (const id of schedule.keys()) {
      if (!eligibleIds.has(id)) schedule.delete(id)
    }
  }
  return renamed
}
