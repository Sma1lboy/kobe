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
import { type BoxRenderable, TextAttributes } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { type Accessor, type JSXElement, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { stripAnsi } from "../../../../test/behavior/screen"
import { useTheme } from "../../context/theme"
import { useTerminalBindings } from "./keys"
import type { CursorPos, TaskPty } from "./pty"
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

/**
 * Heuristic: is this acquire-error message about tmux being absent /
 * unreachable on PATH? Used to swap a plain-English hint in for the
 * raw error tail. We match a couple of phrasings the pty backend
 * emits ("requires tmux on PATH"), plus the bare ENOENT shape Node
 * uses when the binary itself is missing.
 */
function isTmuxMissing(message: string): boolean {
  const m = message.toLowerCase()
  return m.includes("tmux on path") || m.includes("enoent") || m.includes("not found")
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

  // Surfaced when `registry.acquire()` throws (most commonly: tmux not
  // on PATH). Without this, the effect's exception bubbles out of the
  // Solid scheduler and the pane renders blank with no hint as to why.
  const [acquireError, setAcquireError] = createSignal<string | null>(null)

  // Latest plain-text snapshot from the PTY.
  const [snapshot, setSnapshot] = createSignal<string>("")

  // Latest cursor position from the PTY (null when backend can't report).
  const [cursor, setCursor] = createSignal<CursorPos | null>(null)

  // Scroll offset: 0 = follow bottom; positive = N lines back into history.
  const [scrollOffset, setScrollOffset] = createSignal(0)

  /* --------- pty lifecycle ---------- */

  createEffect(
    on([props.cwd, props.taskId], ([cwd, taskId]) => {
      if (!cwd || !taskId) {
        setPty(null)
        setSnapshot("")
        setCursor(null)
        setAcquireError(null)
        return
      }
      const reg = registry()
      let handle: TaskPty
      try {
        handle = reg.acquire(taskId, cwd)
      } catch (err) {
        // The most common failure here is tmux missing on PATH (the
        // pty backend probes synchronously in its constructor). Show
        // a plain-English summary; the raw message is still appended
        // so a user willing to dig can act on it.
        const message = err instanceof Error ? err.message : String(err)
        setAcquireError(message)
        setPty(null)
        setSnapshot("")
        setCursor(null)
        return
      }
      setAcquireError(null)
      setPty(handle)
      // Reset scroll on task switch — every task gets its own viewport.
      setScrollOffset(0)

      // Refresh cursor whenever a fresh snapshot arrives. tmux's cursor
      // moves on every shell input/echo, so coupling it to the snapshot
      // tick keeps text + cursor visually in sync without a second timer.
      const refreshCursor = () => {
        try {
          setCursor(handle.captureCursor())
        } catch {
          setCursor(null)
        }
      }

      // Subscribe; unsubscribe on cleanup OR when the effect re-runs.
      const unsubscribe = handle.onData((snap) => {
        setSnapshot(stripAnsi(snap))
        refreshCursor()
      })
      // If the pty already had a buffer, capture it once so we render
      // immediately without waiting for the first poll tick.
      try {
        const initial = handle.capture()
        if (initial) setSnapshot(stripAnsi(initial))
      } catch {
        /* capture can fail on a freshly-spawned tmux pane; ignore */
      }
      refreshCursor()
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

  // Cursor is only meaningful when we're following the bottom of the
  // buffer; once the user scrolls back, the cursor's reported (x,y)
  // refers to the *live* viewport, not what's currently rendered.
  const showCursor = createMemo(() => focused() && scrollOffset() === 0 && cursor() !== null)

  /* --------- native cursor positioning ----------
   *
   * opentui ships a real terminal cursor (the one the host emulator
   * draws — block, blinking if the host supports it). Earlier we
   * tried inline INVERSE-styled cells but they're hard to see against
   * dim backgrounds AND don't match the rest of the app's typing
   * affordances. So instead we drive opentui's own cursor: when the
   * pane is focused and we know the pty cursor's (x,y), we ask the
   * renderer to place the cursor at the body's absolute screen
   * position + (cursor.x, cursor.y). Padding-1 is added to x because
   * the body has paddingLeft=1 — the snapshot's column 0 lives at
   * screen column body.screenX + 1.
   *
   * When the pane is unfocused or no cursor info is available, we
   * hide it so the host terminal doesn't leave a stray block in the
   * pane. The orchestrator-level cursor (e.g. the chat composer) will
   * reposition it as soon as focus moves elsewhere.
   *
   * We ALSO push the body's measured (cols, rows) into the tmux pane
   * via `pty.resize`. tmux's default 80×24 doesn't match our actual
   * render area, and the cursor (x,y) it reports is in the *tmux*
   * grid — without resizing, the prompt sits at one row in the kobe
   * render but tmux's cursor lives in a different coordinate space,
   * which is exactly the off-by-many-rows symptom the user reported.
   */
  let bodyRef: BoxRenderable | undefined
  const renderer = useRenderer()

  // Push the rendered body's geometry to tmux so cursor coords align.
  createEffect(() => {
    const handle = pty()
    const ref = bodyRef
    if (!handle || !ref) return
    // Subtract the body's own paddingLeft/paddingRight (1+1) from the
    // usable width so the shell doesn't try to write into the padding.
    const cols = Math.max(20, ref.width - 2)
    const rows = Math.max(4, ref.height)
    try {
      handle.resize(cols, rows)
    } catch {
      /* best effort — resize fails silently in tmux when geometry is unchanged */
    }
  })

  // Drive the native cursor.
  createEffect(() => {
    const ref = bodyRef
    if (!ref) return
    const c = cursor()
    if (!showCursor() || !c) {
      // Hide the cursor by parking it off-screen with visible=false.
      renderer.setCursorPosition(0, 0, false)
      return
    }
    // body has paddingLeft=1, so column 0 of the snapshot is at screenX+1.
    renderer.setCursorPosition(ref.screenX + 1 + c.x, ref.screenY + c.y, true)
  })

  // On unmount, hide the cursor so it doesn't leak into whichever pane
  // gains focus next.
  onCleanup(() => {
    try {
      renderer.setCursorPosition(0, 0, false)
    } catch {
      /* renderer may already be torn down */
    }
  })

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      borderColor={focused() ? theme.borderActive : theme.border}
      onMouseUp={() => setFocusedLocal(true)}
    >
      {/* Header (the parent PaneHeader already labels TERMINAL; this
          row keeps the worktree-id detail Stream J shipped). */}
      <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
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
          <box flexGrow={1} paddingLeft={2} paddingTop={1} flexDirection="column" gap={0}>
            <Show
              when={acquireError()}
              fallback={
                <text fg={theme.textMuted}>(no task — press n to create)</text>
              }
            >
              <text fg={theme.error} wrapMode="word">
                terminal unavailable — {isTmuxMissing(acquireError() ?? "") ? "tmux is not installed (try `brew install tmux` or set KOBE_TMUX_BIN)" : "shell could not start"}
              </text>
              <text fg={theme.textMuted} wrapMode="word">
                {acquireError()}
              </text>
            </Show>
          </box>
        }
      >
        <box
          ref={(r: BoxRenderable) => {
            bodyRef = r
          }}
          flexGrow={1}
          paddingLeft={1}
          paddingRight={1}
        >
          {/* Single multi-line `<text>`. opentui's text renderable handles
              `\n`-broken content with `wrapMode="none"`. We tried per-line
              `<For>` rendering earlier — it works, but mixing `<text>`
              and `<box>` siblings made laying out the cursor overlay
              flaky, so the cursor is now driven through the renderer's
              native cursor (see the createEffect above). */}
          <text fg={theme.text} wrapMode="none">
            {visibleLines().join("\n")}
          </text>
        </box>
      </Show>
    </box>
  )
}
