/**
 * Shared spinner pulse — one process-wide 10Hz frame counter that runs ONLY
 * while at least one subscriber is attached. Extracted from the Sidebar's
 * component-level interval (issue: a single loading row re-rendered the whole
 * rail 10×/s); with a store, only the rows that actually animate subscribe,
 * and an all-idle rail keeps zero timers. Framework-free so both runtimes and
 * plain unit tests can drive it.
 */

import { SPINNER_FRAME_MS, SPINNER_TICK_CYCLE } from "../panes/sidebar/row-view"

type Listener = () => void

const listeners = new Set<Listener>()
let frame = 0
let timer: ReturnType<typeof setInterval> | null = null

function tick(): void {
  frame = (frame + 1) % SPINNER_TICK_CYCLE
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      /* one subscriber must not break the others */
    }
  }
}

/** Current common-multiple frame; rows reduce modulo their own frame set. */
export function spinnerFrameSnapshot(): number {
  return frame
}

/**
 * Attach a frame listener. The interval starts on the first subscriber and
 * stops (and rewinds to 0) when the last one leaves, so idle UIs pay nothing.
 */
export function subscribeSpinnerFrame(listener: Listener): () => void {
  listeners.add(listener)
  if (timer === null) {
    timer = setInterval(tick, SPINNER_FRAME_MS)
    // A detached-session TUI must be able to exit while a spinner is live.
    timer.unref?.()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
      frame = 0
    }
  }
}

/** Test-only: whether the shared interval is currently running. */
export function spinnerTimerRunning(): boolean {
  return timer !== null
}
