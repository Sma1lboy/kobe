/**
 * Embedded terminal pane — the terminal-in-the-middle seam (issue #16).
 * Revived from dormancy: the KOBE_TUI workspace host mounts it as the
 * center column running the task's real interactive engine CLI (its
 * `command` prop), and it remains usable as a plain worktree shell.
 * Bleed containment: the body box clips via opentui 0.4's `overflow`
 * and the viewport slices to the measured row count before render.
 *
 * Terminal pane (Stream J) — originally bottom-right of the Conductor layout.
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
 * Output rendering: the backend gives us full snapshots, not deltas,
 * and each snapshot is already one chunk-list per row (the Bun backend
 * builds these straight from xterm's cells; KOB-224). We flatten those
 * rows into a single `StyledText` (with
 * `\n` between rows) and render via ONE `<text>` element — opentui
 * composes the per-cell fg/bg/attrs. Why one `<text>` instead of one per row:
 * per-row `<text>` inside a flex column shifted the body's
 * `screenY` reference, breaking the cursor positioning math
 * (`screenY + cursor.y` → wrong row). The flat layout keeps the
 * body's screenY pinned to the row right under the header, which is
 * what the cursor positioning math assumes.
 *
 * Scrollback / viewport: we keep the latest snapshot rows in a Solid
 * signal and slice to the visible window.
 * `ctrl+pgup`/`ctrl+pgdown` shift a `scrollOffset` signal; when
 * offset is 0 we follow the bottom (so new output is always visible
 * by default).
 *
 * Cursor: the PTY backend reports cursor coordinates from the headless
 * xterm buffer; this component maps them onto opentui's native cursor.
 */

import { type BoxRenderable, StyledText, type TextRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { type Accessor, type JSXElement, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useTheme } from "../../context/theme"
import { t } from "../../i18n"
import { useDialog } from "../../ui/dialog"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { useTerminalBindings } from "./keys"
import type { CursorPos, TaskPty, TerminalRow } from "./pty"
import { type PtyRegistry, getDefaultPtyRegistry } from "./registry"
import { rowsToStyledText } from "./sgr-to-text-chunk"
import { isShellMissing, overlayCursor } from "./terminal-render"
import { computeViewport, viewportCursor } from "./viewport"

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
   * Override the embedded process argv. When set the pane runs this
   * command instead of an interactive shell — e.g. `["claude"]` to
   * make this a PTY view of an interactive Claude Code session (the
   * chat pane's `KOBE_CHAT_ENGINE=interactive` mode). Static for the
   * session, so a plain array (not an accessor) is enough.
   */
  command?: readonly string[]
  /**
   * Optional registry override (tests inject a mock-backed registry).
   * Production usage relies on a single module-level registry below;
   * the orchestrator reaches into it via the exported helper.
   */
  registry?: PtyRegistry
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

  // Latest structured snapshot from the PTY: one style-run list per row,
  // already opentui-ready. The Bun backend builds these straight from
  // xterm's cells; there is no ANSI string to re-parse (KOB-224).
  const [snapshot, setSnapshot] = createSignal<readonly TerminalRow[]>([])

  // Latest cursor position from the PTY (null when backend can't report).
  const [cursor, setCursor] = createSignal<CursorPos | null>(null)

  // Dead-shell flag (revival checklist #5): flips when the PTY reports
  // exit for any reason — its own end, a write failure, or an external
  // kill. The last snapshot stays visible (frozen output has value);
  // the banner + F5 reset are the recovery path.
  const [exited, setExited] = createSignal(false)

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
        setSnapshot([])
        setCursor(null)
        setAcquireError(null)
        return
      }
      const geometry = bodyGeometry()
      if (!geometry) return
      const reg = registry()
      let handle: TaskPty
      try {
        handle = reg.acquire(taskId, cwd, { ...geometry, command: props.command })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setAcquireError(message)
        setPty(null)
        setSnapshot([])
        setCursor(null)
        return
      }
      setAcquireError(null)
      setPty(handle)
      // Reset scroll on task switch — every task gets its own viewport.
      setScrollOffset(0)
    }),
  )

  // Subscribe to whichever PTY is currently active. Lives in its own
  // effect (keyed on `pty()`) instead of inline with acquire so the
  // subscription reattaches automatically when the active PTY changes
  // for any reason — task switch, registry replacement on reset, or
  // recovery after an externally-killed PTY. The original design only
  // wired `onData` inside the acquire effect, which meant a `reset()`
  // (same task, fresh PTY) left the new PTY without a listener —
  // typed characters reached the shell but its echo never made it
  // back to the snapshot signal, surfacing as "the terminal stopped
  // accepting input."
  createEffect(() => {
    const handle = pty()
    setExited(handle ? handle.killed : false)
    if (!handle || handle.killed) return
    const unsubscribeExit = handle.onExit(() => setExited(true))
    onCleanup(() => unsubscribeExit())
    const unsubscribe = handle.onData((snap, c) => {
      setSnapshot(snap)
      setCursor(c)
    })
    // Prime the renderer with whatever the backend has cached so a
    // freshly-mounted (or freshly-reset) pane doesn't blink empty
    // for one tick.
    try {
      const initial = handle.capture()
      if (initial.length > 0) setSnapshot(initial)
      setCursor(handle.captureCursor())
    } catch {
      /* capture can fail on a freshly-spawned shell; ignore */
    }
    onCleanup(() => {
      unsubscribe()
    })
  })

  // Final teardown: drop the registry reference. Don't kill the PTY —
  // the orchestrator owns kill via release().
  onCleanup(() => {
    setPty(null)
  })

  /* --------- bindings ---------- */

  // `F5` opens a confirm modal; user confirms → tear down the
  // current PTY and acquire a fresh one with the same `cwd`. Lives
  // here (not in `keys.ts`) because the dialog context is component-
  // scoped via `useDialog()`. The async confirm needs the current
  // pty / cwd / taskId / geometry at the time the user clicks OK,
  // which we snapshot at click-time so a task switch mid-confirm
  // doesn't reset the wrong shell.
  const dialog = useDialog()
  const requestReset = (): void => {
    const handle = pty()
    if (!handle) return
    const cwd = props.cwd()
    const taskId = props.taskId()
    const geometry = bodyGeometry()
    if (!cwd || !taskId || !geometry) return
    const cwdAtClick = cwd
    const taskIdAtClick = taskId
    const geometryAtClick = geometry
    void DialogConfirm.show(dialog, t("terminal.reset.title"), t("terminal.reset.body"), "cancel").then((ok) => {
      if (ok !== true) return
      const reg = registry()
      // Only reset if the user is still on the same task — a
      // mid-confirm switch invalidates the operation.
      if (props.taskId() !== taskIdAtClick || props.cwd() !== cwdAtClick) return
      try {
        const fresh = reg.reset(taskIdAtClick, cwdAtClick, { ...geometryAtClick, command: props.command })
        setPty(fresh)
        setSnapshot([])
        setCursor(null)
        setScrollOffset(0)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setAcquireError(message)
      }
    })
  }

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
    reset: requestReset,
  })

  /* --------- view ---------- */

  // The snapshot is already one chunk-list per row (the PTY backend
  // hands us structured rows, not an ANSI string). Empty rows are
  // preserved so cursor-capable backends report y coordinates against
  // this array.
  const parsedRows = snapshot

  // Rows visible after applying scroll offset. offset 0 means
  // follow-bottom: render only the last body-height rows, not the
  // whole scrollback. Positive offset moves the viewport upward into
  // history.
  const visibleRange = createMemo(() => computeViewport(parsedRows().length, bodyRows(), scrollOffset()))

  const visibleRows = createMemo(() => {
    const all = parsedRows()
    const range = visibleRange()
    return all.slice(range.start, range.end)
  })

  // Cursor is only meaningful when we're following the bottom of the
  // buffer; once the user scrolls back, the cursor's reported (x,y)
  // refers to the *live* viewport, not what's currently rendered.
  const visibleCursor = createMemo(() => viewportCursor(cursor(), scrollOffset(), visibleRange()))

  const cursorRows = createMemo(() => {
    const c = focused() ? visibleCursor() : null
    return overlayCursor(visibleRows(), c)
  })

  // Flatten every visible row into ONE `StyledText` separated by
  // `\n`s. We render this as a single `<text>` element inside the
  // body so opentui's layout treats the body as a 1:1 cell grid —
  // crucial for the cursor positioning math (`body.screenY + c.y`).
  // An earlier attempt rendered one `<text>` per row inside a flex
  // column; opentui's per-row layout didn't keep `screenY` aligned
  // with pane row indexing, and the cursor landed one row above
  // the visible prompt.
  const styledSnapshot = createMemo(() => new StyledText(rowsToStyledText(cursorRows())))
  // Imperative content push — see the render-site comment (solid 0.4 content-prop gap).
  const [snapshotTextRef, setSnapshotTextRef] = createSignal<TextRenderable | null>(null)
  createEffect(() => {
    const ref = snapshotTextRef()
    if (ref) ref.content = styledSnapshot()
  })

  /* --------- cursor handling ----------
   *
   * The terminal cursor is rendered inline into the StyledText snapshot
   * above instead of using opentui's native host cursor. Keeping text
   * and cursor in one render path avoids the coordinate split that made
   * typed spaces and cursorX look wrong in the nested terminal pane.
   * When terminal has focus we explicitly hide the host cursor so it
   * cannot leave a stale block/bar on top of xterm-rendered text.
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

  // Hide the native host cursor while this pane owns focus; the visible
  // cursor is the inline inverse cell in `cursorRows`.
  createEffect(() => {
    if (!focused()) return
    renderer.setCursorPosition(0, 0, false)
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
      overflow="hidden"
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
      <Show when={exited()}>
        <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
          <text fg={theme.error} wrapMode="none">
            {t("terminal.exited")}
          </text>
        </box>
      </Show>
      <Show when={scrollOffset() > 0}>
        <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
          <text fg={theme.warning} wrapMode="none">
            {t("terminal.scrolledBack", { lines: scrollOffset() })}
          </text>
        </box>
      </Show>

      <box
        ref={(r: BoxRenderable) => {
          setBodyRef(r)
        }}
        flexGrow={1}
        overflow="hidden"
        paddingLeft={1}
        paddingRight={1}
      >
        {/* Body */}
        <Show
          when={pty()}
          fallback={
            <box paddingLeft={1} paddingTop={1} flexDirection="column" gap={0}>
              <Show when={acquireError()} fallback={<text fg={theme.textMuted}>{t("terminal.noTask")}</text>}>
                <text fg={theme.error} wrapMode="word">
                  {isShellMissing(acquireError() ?? "")
                    ? t("terminal.unavailable.shellMissing")
                    : t("terminal.unavailable.spawnFailed")}
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
          {/* opentui 0.4: StyledText is neither a valid JSX child nor honored
              through the solid binding's `content` prop at runtime (the
              reconciler stringifies it — "[object Object]"). Assign the
              TextRenderable's `content` setter directly via ref + effect. */}
          <text
            fg={theme.text}
            wrapMode="none"
            ref={(r: TextRenderable) => {
              setSnapshotTextRef(r)
            }}
          />
        </Show>
      </box>
    </box>
  )
}
