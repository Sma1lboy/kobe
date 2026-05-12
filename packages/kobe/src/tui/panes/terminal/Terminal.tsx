/**
 * Terminal pane (Stream J) — bottom-right of the Conductor layout.
 *
 * Renders an embedded shell scoped to the active task's worktree.
 * Body: a headless xterm screen snapshot fed by the task PTY. The
 * worktree-id label that used to live
 * in an inner header row was removed — it duplicated what the parent
 * PaneHeader already shows, AND it threw off the body's `screenY` by
 * 1 row, parking the cursor on the header instead of the prompt.
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
 * Output rendering: the backend gives us full snapshots, not deltas.
 * The snapshot is fed through `./sgr.ts` which returns one chunk-list
 * per row. We then flatten those rows into a single `StyledText` (with
 * `\n` between rows) and render via ONE `<text>` element — opentui
 * composes the per-cell fg/bg/attrs. Why one `<text>` instead of one per row:
 * per-row `<text>` inside a flex column shifted the body's
 * `screenY` reference, breaking the cursor positioning math
 * (`screenY + cursor.y` → wrong row). The flat layout keeps the
 * body's screenY pinned to the row right under the header, which is
 * what the cursor positioning math assumes.
 *
 * Scrollback / viewport: we keep the latest snapshot in a Solid
 * signal, parse it into chunks, and slice to the visible window.
 * `ctrl+pgup`/`ctrl+pgdown` shift a `scrollOffset` signal; when
 * offset is 0 we follow the bottom (so new output is always visible
 * by default).
 *
 * Cursor: the PTY backend reports cursor coordinates from the headless
 * xterm buffer; this component maps them onto opentui's native cursor.
 */

import { type BoxRenderable, StyledText } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { type Accessor, type JSXElement, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTerminalBindings } from "./keys"
import type { CursorPos, TaskPty } from "./pty"
import { PtyRegistry } from "./registry"
import { parseAnsiSnapshot } from "./sgr"
import { rowsToStyledText } from "./sgr-to-text-chunk"

/* --------------------------------------------------------------------- */
/*  Public surface                                                        */
/* --------------------------------------------------------------------- */

export type TerminalProps = {
  /** Working dir for the shell. Null disables the pane (no task). */
  cwd: Accessor<string | null>
  /** Stable id used for pty registry keying. */
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
 * leftover registry doesn't leak shell processes across tests.
 */
export function _resetDefaultPtyRegistry(): void {
  if (defaultRegistry) defaultRegistry.releaseAll()
  defaultRegistry = null
}

/**
 * Heuristic: is this acquire-error message about the user's shell
 * being absent / unreachable? Used to swap a plain-English hint in for
 * the raw error tail.
 */
function isShellMissing(message: string): boolean {
  const m = message.toLowerCase()
  return m.includes("enoent") || m.includes("not found")
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

  // Surfaced when `registry.acquire()` throws. Without this, the effect's exception bubbles out of the
  // Solid scheduler and the pane renders blank with no hint as to why.
  const [acquireError, setAcquireError] = createSignal<string | null>(null)

  // Latest plain-text snapshot from the PTY.
  const [snapshot, setSnapshot] = createSignal<string>("")

  // Latest cursor position from the PTY (null when backend can't report).
  const [cursor, setCursor] = createSignal<CursorPos | null>(null)

  // Scroll offset: 0 = follow bottom; positive = N lines back into history.
  const [scrollOffset, setScrollOffset] = createSignal(0)

  const [bodyRef, setBodyRef] = createSignal<BoxRenderable | null>(null)
  const [bodyRows, setBodyRows] = createSignal(4)
  const [bodyGeometry, setBodyGeometry] = createSignal<{ cols: number; rows: number } | null>(null)
  const bodyGeometryReady = createMemo(() => bodyGeometry() !== null)

  /* --------- pty lifecycle ---------- */

  createEffect(
    on([props.cwd, props.taskId, bodyGeometryReady], ([cwd, taskId, geometryReady]) => {
      if (!cwd || !taskId || !geometryReady) {
        setPty(null)
        setSnapshot("")
        setCursor(null)
        setAcquireError(null)
        return
      }
      const geometry = bodyGeometry()
      if (!geometry) return
      const reg = registry()
      let handle: TaskPty
      try {
        handle = reg.acquire(taskId, cwd, geometry)
      } catch (err) {
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

      // Subscribe; the listener receives a full snapshot and an
      // optional cursor.
      const unsubscribe = handle.onData((snap, c) => {
        setSnapshot(snap)
        setCursor(c)
      })
      // If the pty already had a buffer, prime the renderer immediately
      // so a freshly-mounted Terminal doesn't blink empty for one tick.
      try {
        const initial = handle.capture()
        if (initial) setSnapshot(initial)
        setCursor(handle.captureCursor())
      } catch {
        /* capture can fail on a freshly-spawned shell; ignore */
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

  // Parse the snapshot (text + SGR escapes) into one chunk-list per
  // row. Memoized on `snapshot()`, so a cursor-only update doesn't
  // re-parse the (unchanged) text. Empty rows are preserved so the
  // Cursor-capable backends report y coordinates against this array.
  const parsedRows = createMemo(() => parseAnsiSnapshot(snapshot()))

  // Rows visible after applying scroll offset. offset 0 means
  // follow-bottom: render only the last body-height rows, not the
  // whole scrollback. Positive offset moves the viewport upward into
  // history.
  const visibleRange = createMemo(() => {
    const all = parsedRows()
    const height = Math.max(1, bodyRows())
    const offset = Math.max(0, scrollOffset())
    const end = Math.max(0, all.length - offset)
    const start = Math.max(0, end - height)
    return { start, end }
  })

  const visibleRows = createMemo(() => {
    const all = parsedRows()
    const range = visibleRange()
    return all.slice(range.start, range.end)
  })

  // Flatten every visible row into ONE `StyledText` separated by
  // `\n`s. We render this as a single `<text>` element inside the
  // body so opentui's layout treats the body as a 1:1 cell grid —
  // crucial for the cursor positioning math (`body.screenY + c.y`).
  // An earlier attempt rendered one `<text>` per row inside a flex
  // column; opentui's per-row layout didn't keep `screenY` aligned
  // with pane row indexing, and the cursor landed one row above
  // the visible prompt.
  const styledSnapshot = createMemo(() => new StyledText(rowsToStyledText(visibleRows())))

  // Cursor is only meaningful when we're following the bottom of the
  // buffer; once the user scrolls back, the cursor's reported (x,y)
  // refers to the *live* viewport, not what's currently rendered.
  const visibleCursor = createMemo(() => {
    const c = cursor()
    if (!c || scrollOffset() !== 0) return null
    const range = visibleRange()
    if (c.y < range.start || c.y >= range.end) return null
    return { x: c.x, y: c.y - range.start }
  })

  const showCursor = createMemo(() => focused() && visibleCursor() !== null)

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
   * We ALSO push the body's measured (cols, rows) into the backend via
   * `pty.resize`. The Bun PTY backend translates those into terminal
   * resize events.
   */
  const renderer = useRenderer()
  // Reactive terminal dims — when the host window resizes, this changes
  // and re-fires effects that read the body's live `width/height`.
  const dims = useTerminalDimensions()

  // Layout-tick signal — bumped on a slow interval so effects that read
  // non-reactive geometry (`ref.width/height/screenX/screenY`) catch up
  // with layout changes that don't have their own Solid signal (the
  // splitter drag in app.tsx mutates pane-size signals, but the *body*
  // box's width is computed downstream, and Solid doesn't observe it
  // through the BoxRenderable instance). We deliberately DO NOT use
  // a per-frame callback here; real PTY backends may turn resizes into
  // SIGWINCH and prompt-rendering shells can reprint on every resize.
  const [geomTick, setGeomTick] = createSignal(0)
  // 1 s is plenty for catching splitter drags; the previous 250 ms
  // tick fired the cursor-positioning effect 4×/sec doing nothing
  // most of the time, which added measurable CPU floor.
  const geomTimer = setInterval(() => {
    setGeomTick((n) => (n + 1) & 0xff)
  }, 1000)
  onCleanup(() => clearInterval(geomTimer))

  // Track last pushed geometry so we don't fire `pty.resize` on every
  // re-render; real PTY backends may emit SIGWINCH even when geometry
  // is unchanged.
  let lastResize: { cols: number; rows: number } | null = null

  // Measure the rendered body's geometry before spawning the PTY. This
  // avoids booting shells at the default 80x24 and immediately resizing
  // them, which makes zsh/starship-style prompts redraw into stray
  // standalone prompt lines on startup.
  createEffect(() => {
    const ref = bodyRef()
    // Read dims + geomTick so this effect re-runs when the host
    // terminal resizes OR a splitter drag changes our body size.
    dims()
    geomTick()
    if (!ref) return
    // Subtract the body's own paddingLeft/paddingRight (1+1) from the
    // usable width so the shell doesn't try to write into the padding.
    const cols = Math.max(20, ref.width - 2)
    const rows = Math.max(4, ref.height)
    setBodyRows(rows)
    setBodyGeometry((cur) => (cur && cur.cols === cols && cur.rows === rows ? cur : { cols, rows }))
  })

  // Push geometry changes after startup to the backend.
  createEffect(() => {
    const handle = pty()
    const geometry = bodyGeometry()
    if (!handle || !geometry) return
    const { cols, rows } = geometry
    if (lastResize && lastResize.cols === cols && lastResize.rows === rows) return
    lastResize = { cols, rows }
    try {
      handle.resize(cols, rows)
    } catch {
      /* best effort */
    }
  })

  // Drive the native cursor. Re-runs on cursor(), focused(),
  // scrollOffset(), bodyRef, and host-window resize. Cursor() updates
  // every ~80 ms from the PTY poll loop, which is more than enough to
  // keep the visible block in sync with the shell.
  createEffect(() => {
    const ref = bodyRef()
    dims()
    geomTick()
    if (!ref) return
    const c = visibleCursor()
    if (!showCursor() || !c) {
      // Hide the cursor by parking it off-screen with visible=false.
      renderer.setCursorPosition(0, 0, false)
      return
    }
    // Make sure the host terminal actually draws something — some
    // emulators default to a hidden cursor inside alt-screen until a
    // style is explicitly set. A blinking bar is less visually noisy
    // than a permanent block inside the nested terminal pane.
    try {
      renderer.setCursorStyle({ style: "line", blinking: true })
    } catch {
      /* older opentui versions may not expose setCursorStyle; ignore */
    }
    // Translate pane coords -> screen coords for the renderer.
    //
    // - `screenX + 1`: body has `paddingLeft=1`, so the first visible
    //   column of the snapshot is at `body.screenX + 1`. Same for cy
    //   below — we need to offset the cursor by the same padding the
    //   text rendering uses.
    // - `screenY + 1`: parent box (`<box borderColor=...>`) draws a
    //   border that takes one screen row at the top. opentui's
    //   `ref.screenY` for the body reports the parent's outer edge
    //   (i.e. the border row), not the content row inside; meanwhile
    //   the text content is rendered starting one row below the
    //   border. Without the +1, the cursor lands on the border row,
    //   one row above the visible prompt. Verified empirically via a
    //   debug dump in /tmp/kobe-terminal-debug.log: with body
    //   screenY=35, cursor at y=29 was reported by the backend but the
    //   rendered prompt was at screen row 65 (i.e. 35+1+29), not 64.
    renderer.setCursorPosition(ref.screenX + 1 + c.x, ref.screenY + 1 + c.y, true)
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
      borderColor={focused() ? theme.focusAccent : theme.border}
      onMouseUp={() => setFocusedLocal(true)}
    >
      {/* Scroll affordance — only rendered when the user has scrolled
          back into history. Replaces what used to be a permanent
          worktree-id header row; that row was redundant with the
          parent PaneHeader's right-side label AND it threw off the
          body's `screenY` by 1, parking the cursor on the header
          instead of the prompt. Conditional render means the body's
          screenY equals the pane's content top in the steady state. */}
      <Show when={scrollOffset() > 0}>
        <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
          <text fg={theme.warning} wrapMode="none">
            ↑ scrolled {scrollOffset()}L (ctrl+pgdn to follow)
          </text>
        </box>
      </Show>

      <box
        ref={(r: BoxRenderable) => {
          setBodyRef(r)
        }}
        flexGrow={1}
        paddingLeft={1}
        paddingRight={1}
      >
        {/* Body */}
        <Show
          when={pty()}
          fallback={
            <box paddingLeft={1} paddingTop={1} flexDirection="column" gap={0}>
              <Show when={acquireError()} fallback={<text fg={theme.textMuted}>(no task — press n to create)</text>}>
                <text fg={theme.error} wrapMode="word">
                  terminal unavailable —{" "}
                  {isShellMissing(acquireError() ?? "") ? "configured shell is not available" : "shell could not start"}
                </text>
                <text fg={theme.textMuted} wrapMode="word">
                  {acquireError()}
                </text>
              </Show>
            </box>
          }
        >
          {/* Single `<text>` element rendering the whole snapshot.
              Per-row chunks are flattened into one StyledText with
              `\n` separators (see `rowsToStyledText`). This shape
              matters: rendering one <text> per row inside a flex
              column shifted the body's `screenY` reference such that
              `screenY + cursor.y` landed one row above the prompt.
              Keeping a single multi-line `<text>` preserves the
              original layout assumption that drives the cursor math
              in the createEffect below. */}
          <text fg={theme.text} wrapMode="none">
            {styledSnapshot()}
          </text>
        </Show>
      </box>
    </box>
  )
}
