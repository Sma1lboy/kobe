/**
 * Framework-free poll loops for the Ops pane — the badge fallback poll and
 * the per-window turn-status (capture-pane quiescence) poll, extracted from
 * `tui/ops/host.tsx` so the Solid AND React hosts (issue #15, G3) run the
 * SAME loop bodies verbatim. Only types are imported (erased at runtime);
 * all IO — tmux capture-pane / window-option writes, the transcript mtime
 * probe, the attach gate — is injected (`tui/ops/host-io.ts` builds the
 * real set), which is also what makes these loops unit-testable under
 * vitest with fakes. Cadence math stays in `./activity-poll`.
 */

import { createHash } from "node:crypto"
import type { ChatTabTurnState } from "@/engine/turn-detector"
import type { TranscriptActivity } from "../../client/remote-orchestrator"
import {
  ACTIVITY_POLL_MIN_MS,
  TURN_STATUS_POLL_MS,
  nextActivityPollDelay,
  nextTurnStatusPollDelay,
} from "./activity-poll"

/** Consecutive unchanged capture-pane reads before a completion marker counts as "done". */
export const STABLE_POLLS_FOR_DONE = 2
/** tmux window option the ChatTab turn chip reads. */
export const CHAT_TAB_STATE_OPTION = "@kobe_tab_state"

export function fingerprint(text: string): string {
  return createHash("sha1").update(text).digest("hex")
}

/* ─── local fallback badge poll ──────────────────────────────────────── */

export interface BadgePollIo {
  /** Attach gate — a detached (background) session skips the fs sweep. */
  readonly sessionAttached: () => Promise<boolean>
  /** Newest transcript mtime for this task's worktree (`latestTranscriptMtime`). */
  readonly latestMtime: () => Promise<number>
}

/** Host-side badge state, shared with the daemon-push effect (see host.tsx). */
export interface BadgePollHooks {
  readonly isPrimed: () => boolean
  /** First read seeds the baseline so only post-mount activity flags. */
  readonly prime: (mtime: number) => void
  readonly setLatest: (mtime: number) => void
}

/**
 * The `● new` badge's LOCAL fallback poll — runs only while there's no
 * daemon-collected `transcript.activity` data. Adaptive backoff: fast while
 * the transcript advances, ramping toward the max while idle (the probe
 * readdir+stats an unboundedly growing dir). Transient read failures are
 * swallowed: the worktree can vanish mid-poll during task deletion, and the
 * pane process has no crash net. Returns the dispose function.
 */
export function startLocalBadgePoll(io: BadgePollIo, hooks: BadgePollHooks): () => void {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let delayMs = ACTIVITY_POLL_MIN_MS
  let idleStreak = 0
  let lastSeenMtime = 0
  async function poll(): Promise<void> {
    // Detached (background) session: skip the readdir+stat sweep entirely —
    // the badge is invisible. Next tick after re-attach resumes.
    if (!(await io.sessionAttached())) {
      if (!disposed) timer = setTimeout(() => void poll(), delayMs)
      return
    }
    try {
      const mtime = await io.latestMtime()
      if (disposed) return
      if (!hooks.isPrimed()) {
        hooks.prime(mtime)
        lastSeenMtime = mtime
      }
      // Snap back to the fast interval the instant the transcript advances;
      // otherwise ramp the delay so an idle pane stops stat-churning.
      if (mtime > lastSeenMtime) {
        lastSeenMtime = mtime
        idleStreak = 0
      } else {
        idleStreak++
      }
      hooks.setLatest(mtime)
    } catch {
      // A failed read isn't "activity" — let the idle ramp keep climbing and
      // the next tick retry (or `disposed` stop us).
      idleStreak++
    } finally {
      if (!disposed) {
        delayMs = nextActivityPollDelay(delayMs, idleStreak)
        timer = setTimeout(() => void poll(), delayMs)
      }
    }
  }
  void poll()
  return () => {
    disposed = true
    if (timer) clearTimeout(timer)
  }
}

/* ─── per-window turn-status poll ────────────────────────────────────── */

/** The slice of `EngineTurnDetector` this loop consumes (structural, fakeable). */
export interface TurnDetectorLike {
  supportsCompletionMarkers(): boolean
  latestCompletion(worktree: string): Promise<{ readonly id: string } | null>
}

export interface TurnStatusIo {
  readonly sessionAttached: () => Promise<boolean>
  /** `tmux capture-pane` of the paired engine pane (quiescence source). */
  readonly capturePane: () => Promise<string>
  /** Write the ChatTab turn chip ({@link CHAT_TAB_STATE_OPTION}). */
  readonly setTurnState: (state: ChatTabTurnState) => Promise<void>
}

export interface TurnStatusOpts {
  readonly worktree: string
  readonly detector: TurnDetectorLike
  /** Whether the daemon is publishing transcript activity for this worktree. */
  readonly usingShared: () => boolean
  /** This worktree's slice of the daemon push (`null` when absent). */
  readonly sharedEntry: () => TranscriptActivity | null
}

/**
 * Per-window turn detector loop. The engine adapter owns completion markers;
 * this loop owns only the tmux-local quiescence check for its paired engine
 * pane, so sibling ChatTabs on the same worktree don't report done unless
 * THIS window actually changed. The capture-pane hash + turn-state write
 * stay strictly in-process (the daemon never touches tmux); in shared mode
 * the COMPLETION read comes from the daemon push and the capture cadence
 * ramps while quiescent, in fallback mode it's a local `latestCompletion`
 * read on a fixed cadence — verbatim the pre-daemon behavior. Returns the
 * dispose function.
 */
export function startTurnStatusPoll(opts: TurnStatusOpts, io: TurnStatusIo): () => void {
  const { detector } = opts
  let disposed = false
  let baselineCompletionId: string | null = null
  let baselinePrimed = false
  let paneHash = ""
  let observedPaneActivity = false
  let stablePolls = 0
  let published: ChatTabTurnState | null = null
  // Adaptive capture-pane cadence (shared mode only): ramps up while the
  // shared transcript is quiescent, snaps back when its mtime advances.
  let delayMs = TURN_STATUS_POLL_MS
  let lastSharedMtime = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  async function publish(state: ChatTabTurnState): Promise<void> {
    if (state === published) return
    published = state
    await io.setTurnState(state)
  }

  /** Latest completion id — from the shared push when available, else a local read. */
  async function latestCompletionId(): Promise<string | null> {
    if (opts.usingShared()) return opts.sharedEntry()?.completionId ?? null
    return (await detector.latestCompletion(opts.worktree))?.id ?? null
  }

  async function prime(): Promise<void> {
    try {
      paneHash = fingerprint(await io.capturePane())
      baselineCompletionId = await latestCompletionId()
      baselinePrimed = true
      await publish(detector.supportsCompletionMarkers() ? "idle" : "unknown")
    } catch {
      // Transient failures during the delete→kill teardown window must not
      // crash this crash-net-less pane process; the next poll() re-primes.
    }
  }

  async function poll(): Promise<void> {
    // Detached session: no capture-pane spawn for an invisible status chip.
    if (!(await io.sessionAttached())) {
      if (!disposed) timer = setTimeout(() => void poll(), delayMs)
      return
    }
    const shared = opts.usingShared()
    try {
      const nextPaneHash = fingerprint(await io.capturePane())
      if (disposed) return
      // Lazily seed the baseline if shared activity arrived only after prime
      // ran with no entry — so the first daemon-pushed completion isn't
      // mistaken for a fresh "done".
      if (shared && !baselinePrimed) {
        baselineCompletionId = opts.sharedEntry()?.completionId ?? null
        baselinePrimed = true
      }
      // Track shared-transcript mtime advance for the adaptive cadence.
      const sharedMtime = shared ? (opts.sharedEntry()?.mtimeMs ?? 0) : 0
      const mtimeAdvanced = sharedMtime > lastSharedMtime
      if (sharedMtime > lastSharedMtime) lastSharedMtime = sharedMtime

      if (nextPaneHash !== paneHash) {
        paneHash = nextPaneHash
        observedPaneActivity = true
        stablePolls = 0
        await publish(detector.supportsCompletionMarkers() ? "running" : "unknown")
      } else if (observedPaneActivity) {
        stablePolls++
      }

      if (detector.supportsCompletionMarkers() && observedPaneActivity && stablePolls >= STABLE_POLLS_FOR_DONE) {
        const completionId = await latestCompletionId()
        // Done rule unchanged: a NEW completion id past the baseline, with
        // the pane having gone quiescent, means the turn finished.
        if (!disposed && completionId !== null && completionId !== baselineCompletionId) {
          baselineCompletionId = completionId
          observedPaneActivity = false
          stablePolls = 0
          await publish("done")
        }
      }
      // Cadence: shared mode ramps the capture-pane interval while idle;
      // fallback keeps the fixed 1.5s tick.
      delayMs = shared ? nextTurnStatusPollDelay(delayMs, mtimeAdvanced, published) : TURN_STATUS_POLL_MS
    } catch {
      // capture-pane / the turn-state write fire tmux against a pane that a
      // task deletion tears down mid-flight — swallow so the race degrades
      // to a quiet no-op instead of crashing the Ops pane to a shell.
      delayMs = TURN_STATUS_POLL_MS
    } finally {
      if (!disposed) timer = setTimeout(() => void poll(), delayMs)
    }
  }

  void prime()
  timer = setTimeout(() => void poll(), TURN_STATUS_POLL_MS)
  return () => {
    disposed = true
    if (timer) clearTimeout(timer)
  }
}
