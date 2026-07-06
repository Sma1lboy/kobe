import { createHash } from "node:crypto"
import type { ChatTabTurnState } from "@/engine/turn-detector"
import type { TranscriptActivity } from "../../client/remote-orchestrator"
import {
  ACTIVITY_POLL_MIN_MS,
  TURN_STATUS_POLL_MS,
  nextActivityPollDelay,
  nextTurnStatusPollDelay,
} from "./activity-poll"

export const STABLE_POLLS_FOR_DONE = 2
export const CHAT_TAB_STATE_OPTION = "@kobe_tab_state"

export function fingerprint(text: string): string {
  return createHash("sha1").update(text).digest("hex")
}

export interface BadgePollIo {
  readonly sessionAttached: () => Promise<boolean>
  readonly latestMtime: () => Promise<number>
}

export interface BadgePollHooks {
  readonly isPrimed: () => boolean
  readonly prime: (mtime: number) => void
  readonly setLatest: (mtime: number) => void
}

export function startLocalBadgePoll(io: BadgePollIo, hooks: BadgePollHooks): () => void {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let delayMs = ACTIVITY_POLL_MIN_MS
  let idleStreak = 0
  let lastSeenMtime = 0
  async function poll(): Promise<void> {
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
      if (mtime > lastSeenMtime) {
        lastSeenMtime = mtime
        idleStreak = 0
      } else {
        idleStreak++
      }
      hooks.setLatest(mtime)
    } catch {
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

export interface TurnDetectorLike {
  supportsCompletionMarkers(): boolean
  latestCompletion(worktree: string): Promise<{ readonly id: string } | null>
}

export interface TurnStatusIo {
  readonly sessionAttached: () => Promise<boolean>
  readonly capturePane: () => Promise<string>
  readonly setTurnState: (state: ChatTabTurnState) => Promise<void>
}

export interface TurnStatusOpts {
  readonly worktree: string
  readonly detector: TurnDetectorLike
  readonly usingShared: () => boolean
  readonly sharedEntry: () => TranscriptActivity | null
}

export function startTurnStatusPoll(opts: TurnStatusOpts, io: TurnStatusIo): () => void {
  const { detector } = opts
  let disposed = false
  let baselineCompletionId: string | null = null
  let baselinePrimed = false
  let paneHash = ""
  let observedPaneActivity = false
  let stablePolls = 0
  let published: ChatTabTurnState | null = null
  let delayMs = TURN_STATUS_POLL_MS
  let lastSharedMtime = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  async function publish(state: ChatTabTurnState): Promise<void> {
    if (state === published) return
    published = state
    await io.setTurnState(state)
  }

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
    } catch {}
  }

  async function poll(): Promise<void> {
    if (!(await io.sessionAttached())) {
      if (!disposed) timer = setTimeout(() => void poll(), delayMs)
      return
    }
    const shared = opts.usingShared()
    try {
      const nextPaneHash = fingerprint(await io.capturePane())
      if (disposed) return
      if (shared && !baselinePrimed) {
        baselineCompletionId = opts.sharedEntry()?.completionId ?? null
        baselinePrimed = true
      }
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
        if (!disposed && completionId !== null && completionId !== baselineCompletionId) {
          baselineCompletionId = completionId
          observedPaneActivity = false
          stablePolls = 0
          await publish("done")
        }
      }
      delayMs = shared ? nextTurnStatusPollDelay(delayMs, mtimeAdvanced, published) : TURN_STATUS_POLL_MS
    } catch {
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
