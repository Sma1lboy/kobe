/**
 * Terminal pane (Stream J) — bottom-right of the Conductor layout.
 *
 * Renders an embedded shell scoped to the active task's worktree.
 * Header: `terminal — <cwd-basename>`. Body: ANSI-stripped scrollback
 * with a viewport cursor.
 *
 * Lifecycle (per the Stream J brief):
 *   - When `cwd` and `taskId` resolve to non-null values, acquire a
 *     `TaskPty` from the registry. `acquire` reuses an existing PTY if
 *     one is already running for the task — that's the "kept alive
 *     while in_progress" rule.
 *   - When `cwd` or `taskId` change to a new task, we DON'T kill the
 *     old PTY (the orchestrator owns archive lifecycle). We just stop
 *     subscribing to its data and start subscribing to the new one's.
 *     This component never calls `registry.release()` — that's the
 *     orchestrator's job (Stream E will wire it on the archive event).
 *   - When `cwd` is null, we render an empty placeholder ("no task
 *     selected"). No PTY is acquired.
 *   - On unmount we drop our subscription but DON'T kill the PTY (same
 *     reason as above; the registry survives the component).
 *
 * Mouse: clicking the pane sets the local `focusedLocal` signal and
 * calls a hypothetical parent `onFocus` (not wired in v1; the parent
 * will own focus once Stream E adds global focus). The brief is
 * explicit: clicking focuses the pane, that's all — no mouse-passthrough
 * to the shell.
 *
 * Output rendering: tmux gives us full pane snapshots, not deltas. We
 * pass the snapshot through `stripAnsi` (re-imported from the behavior
 * harness — it's pure and lives at `test/behavior/screen.ts`; see the
 * import below for why we expose it from there). The result is plain
 * text; we render line-by-line so the opentui `<text>` renderable can
 * lay it out without trying to interpret ANSI escapes.
 *
 * Scrollback / viewport: we keep the latest snapshot in a Solid signal
 * and slice it to the visible window. `ctrl+pgup`/`ctrl+pgdown` shift
 * a `scrollOffset` signal; when offset is 0 we follow the bottom (so
 * new output is always visible by default). The brief says "v1 is
 * plain-text scrollback; ANSI control codes are stripped using the
 * existing `test/behavior/screen.ts` utility (export it from there or
 * reimplement minimally)" — we import from the behavior path. That
 * file is already part of the source tree and exporting it here is a
 * one-liner.
 */

import { basename } from "node:path"
import { TextAttributes } from "@opentui/core"
import { type Accessor, type JSXElement, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { stripAnsi } from "../../../../test/behavior/screen"
import { useTheme } from "../../context/theme"
import { useTerminalBindings } from "./keys"
import type { TaskPty } from "./pty"
import { PtyRegistry } from "./registry"

/* --------------------------------------------------------------------- */
/*  Public surface                                                        */
/* --------------------------------------------------------------------- */

export type TerminalProps = {
  /** Working dir for the shell. Null disables the pane (no task). */
  cwd: Accessor<string | null>
  /** Stable id used for tmux session naming or pty registry keying. */
  taskId: Accessor<string | null>
  focused?: Accessor<boolean>
  /**
   * Optional registry override (tests inject a mock-backed registry).
   * Production usage relies on a single module-level registry below;
   * the orchestrator reaches into it via the exported helper.
   */
  registry?: PtyRegistry
}

/* --------------------------------------------------------------------- */
/*  Module-level registry                                                 */
/* --------------------------------------------------------------------- */

/**
 * Default registry shared by every `<Terminal />` instance in the app.
 * Stream E will reach into it to call `release(taskId)` when a task is
 * archived; until then the registry just keeps PTYs alive.
 *
 * Tests pass their own registry via `props.registry`.
 */
let defaultRegistry: PtyRegistry | null = null

export function getDefaultPtyRegistry(): PtyRegistry {
  if (!defaultRegistry) defaultRegistry = new PtyRegistry()
  return defaultRegistry
}

/**
 * Reset the module-level registry. Tests use this between cases so a
 * leftover registry doesn't leak tmux sessions across tests.
 */
export function _resetDefaultPtyRegistry(): void {
  if (defaultRegistry) defaultRegistry.releaseAll()
  defaultRegistry = null
}

/* --------------------------------------------------------------------- */
/*  Component                                                             */
/* --------------------------------------------------------------------- */

export function Terminal(props: TerminalProps): JSXElement {
  const { theme } = useTheme()
  const registry = () => props.registry ?? getDefaultPtyRegistry()

  // Local "focus" — Stream E will eventually own this, but for v1 the
  // pane manages its own focus on click. Default to props.focused if
  // provided so behavior tests can drive focus.
  const [focusedLocal, setFocusedLocal] = createSignal(false)
  const focused = () => props.focused?.() ?? focusedLocal()

  // The current PTY — null when no task is active.
  const [pty, setPty] = createSignal<TaskPty | null>(null)

  // Latest plain-text snapshot from the PTY.
  const [snapshot, setSnapshot] = createSignal<string>("")

  // Scroll offset: 0 = follow bottom; positive = N lines back into history.
  const [scrollOffset, setScrollOffset] = createSignal(0)

  /* --------- pty lifecycle ---------- */

  createEffect(
    on([props.cwd, props.taskId], ([cwd, taskId]) => {
      if (!cwd || !taskId) {
        setPty(null)
        setSnapshot("")
        return
      }
      const reg = registry()
      const handle = reg.acquire(taskId, cwd)
      setPty(handle)
      // Reset scroll on task switch — every task gets its own viewport.
      setScrollOffset(0)

      // Subscribe; unsubscribe on cleanup OR when the effect re-runs.
      const unsubscribe = handle.onData((snap) => {
        setSnapshot(stripAnsi(snap))
      })
      // If the pty already had a buffer, capture it once so we render
      // immediately without waiting for the first poll tick.
      try {
        const initial = handle.capture()
        if (initial) setSnapshot(stripAnsi(initial))
      } catch {
        /* capture can fail on a freshly-spawned tmux pane; ignore */
      }
      onCleanup(() => {
        unsubscribe()
      })
    }),
  )

  // Final teardown: drop the registry reference. Don't kill the PTY —
  // the orchestrator owns kill via release().
  onCleanup(() => {
    setPty(null)
  })

  /* --------- bindings ---------- */

  useTerminalBindings({
    focused,
    write: (data) => {
      const handle = pty()
      if (!handle || handle.killed) return
      handle.write(data)
    },
    scroll: (lines) => {
      setScrollOffset((cur) => Math.max(0, cur - lines))
      // (negative `lines` moves up = increases the offset toward
      // history, but we accept positive integers in `scroll(n)`'s
      // contract being "lines forward, i.e. toward newer output";
      // tests assert this convention.)
    },
  })

  /* --------- view ---------- */

  const headerLabel = createMemo(() => {
    const cwd = props.cwd()
    if (!cwd) return "terminal — (no task)"
    return `terminal — ${basename(cwd)}`
  })

  // Lines visible after applying scroll offset. We split by \n, then
  // slice off the bottom `scrollOffset` lines (negative offset would
  // be below the bottom, which we clamp).
  const visibleLines = createMemo(() => {
    const all = snapshot().split("\n")
    const offset = Math.max(0, scrollOffset())
    if (offset === 0) return all
    const cut = Math.max(0, all.length - offset)
    return all.slice(0, cut)
  })

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      backgroundColor={theme.background}
      borderColor={focused() ? theme.borderActive : theme.border}
      onMouseUp={() => setFocusedLocal(true)}
    >
      {/* Header */}
      <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1} backgroundColor={theme.backgroundPanel}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
          {headerLabel()}
        </text>
        <Show when={scrollOffset() > 0}>
          <text fg={theme.warning} wrapMode="none">
            {"  "}↑ scrolled {scrollOffset()}L (ctrl+pgdn to follow)
          </text>
        </Show>
      </box>

      {/* Body */}
      <Show
        when={pty()}
        fallback={
          <box flexGrow={1} paddingLeft={2} paddingTop={1}>
            <text fg={theme.textMuted}>no task selected — terminal disabled</text>
          </box>
        }
      >
        <box flexGrow={1} paddingLeft={1} paddingRight={1} backgroundColor={theme.background}>
          {/* v1 renders the visible scrollback as a single multi-line
              `<text>`. opentui's text renderable handles `\n`-broken
              content with `wrapMode="none"`. We tried a `<For>` over
              one-`<text>`-per-line earlier and observed render glitches
              inside `<scrollbox>` (lines never appeared even with the
              snapshot signal updating). The single-`<text>` path is
              the reliable one for plain-text scrollback; if/when we
              upgrade to ANSI-aware rendering we'll revisit. */}
          <text fg={theme.text} wrapMode="none">
            {visibleLines().join("\n")}
          </text>
        </box>
      </Show>
    </box>
  )
}
