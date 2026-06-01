/**
 * Render-error safety net for a pane's component tree (KOB).
 *
 * The v0.6 panes (`kobe tasks`, `kobe ops`) each run their own opentui/solid
 * render loop with NO error boundary — so a single throw in render (e.g. a
 * transient frame during a task delete, where a reactive lookup briefly hits a
 * just-removed task) crashed the whole pane into opentui's raw red error dump.
 *
 * This wraps a subtree, logs the error (so it's still diagnosable in the pane /
 * daemon log), shows a calm one-line state, and SELF-HEALS:
 *   - resets when `resetOn` changes — the next `task.snapshot` settles the
 *     transient, so the pane re-renders cleanly without user action;
 *   - as a backstop, retries on a short timer up to a cap, so a one-frame
 *     transient clears even without a `resetOn` signal.
 * A persistent error stops retrying (no busy-loop) and just shows the message.
 */

import { TextAttributes } from "@opentui/core"
import { ErrorBoundary, type JSX, createEffect, createSignal, on, onCleanup, untrack } from "solid-js"
import { useTheme } from "../context/theme"

const RETRY_MS = 400
const MAX_TIMED_RETRIES = 5

export function PaneErrorBoundary(props: {
  /** Short name for the log line + fallback copy (e.g. "tasks", "ops"). */
  label?: string
  /**
   * Reactive dependency whose change means "upstream data updated — retry the
   * render". Wire it to the live task snapshot so a delete-frame transient
   * heals as soon as the next snapshot arrives.
   */
  resetOn?: () => unknown
  children: JSX.Element
}): JSX.Element {
  // Lives in the boundary's scope (not the fallback closure) so the retry
  // budget persists across repeated fallback re-renders and a hard error
  // can't loop forever.
  const [timedRetries, setTimedRetries] = createSignal(0)
  return (
    <ErrorBoundary
      fallback={(err, reset) => {
        console.error(`[kobe ${props.label ?? "pane"}] render error:`, err)
        // Heal on the next upstream update; clears the retry budget so a later,
        // unrelated transient gets a fresh set of retries.
        if (props.resetOn) {
          createEffect(
            on(
              props.resetOn,
              () => {
                setTimedRetries(0)
                reset()
              },
              { defer: true },
            ),
          )
        }
        // Backstop timer — capped so a genuine, persistent bug shows the
        // message instead of flashing on a reset loop.
        if (untrack(timedRetries) < MAX_TIMED_RETRIES) {
          const t = setTimeout(() => {
            setTimedRetries((n) => n + 1)
            reset()
          }, RETRY_MS)
          onCleanup(() => clearTimeout(t))
        }
        return <ErrorFallback label={props.label} message={errorMessage(err)} />
      }}
    >
      {props.children}
    </ErrorBoundary>
  )
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

function ErrorFallback(props: { label?: string; message: string }): JSX.Element {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" flexGrow={1} padding={1} backgroundColor={theme.background}>
      <text fg={theme.error} attributes={TextAttributes.BOLD} wrapMode="none">
        ⚠ {props.label ?? "pane"} hit a render error — recovering…
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        {props.message}
      </text>
    </box>
  )
}
