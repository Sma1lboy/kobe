/**
 * Embedded terminal pane — the terminal-in-the-middle seam (issue #16).
 * The KOBE_TUI workspace host mounts it as the center column running the
 * task's real interactive engine CLI (its `command` prop); it also works
 * as a plain worktree shell. Body: a headless xterm screen snapshot fed by
 * the task PTY, clipped via opentui's `overflow` + viewport slicing.
 *
 * Lifecycle:
 *   - When `cwd` and `taskId` resolve to non-null values, acquire a
 *     `TaskPty` from the registry. `acquire` reuses an existing PTY if
 *     one is already running for the task — that's the "kept alive
 *     while in_progress" rule.
 *   - When `cwd` or `taskId` change to a new task, we DON'T kill the
 *     old PTY (the orchestrator owns archive lifecycle). We just stop
 *     subscribing to its data and start subscribing to the new one's.
 *     This component never calls `registry.release()`.
 *   - When `cwd` is null, we render an empty placeholder ("no task
 *     selected"). No PTY is acquired.
 *   - On unmount we drop our subscription but DON'T kill the PTY (same
 *     reason as above; the registry survives the component).
 *
 * Mouse: clicking the pane sets the local `focusedLocal` signal; no
 * mouse-passthrough to the shell.
 *
 * Scrollback / viewport: the latest snapshot rows live in a Solid signal,
 * sliced to the visible window. `ctrl+pgup`/`ctrl+pgdown` shift a
 * `scrollOffset` signal; offset 0 follows the bottom.
 *
 * Cursor: the PTY backend reports cursor coordinates from the headless
 * xterm buffer, mapped onto opentui's native cursor — see the render-site
 * comment below for why it's inlined into the text instead.
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
   * Fires once when the PTY reports exit (or is already dead at mount) —
   * `undefined` for the default "leave the dead shell + exit banner up"
   * behavior. Used by `TerminalTabs.tsx` to auto-close command tabs
   * (editor / degraded shell) and to degrade engine tabs to a shell.
   */
  onExit?: () => void
  /**
   * Bump this to force a fresh PTY acquire under the SAME `cwd`/`taskId` —
   * for a caller whose underlying command changed without the pty key
   * changing (`TerminalTabs.tsx`'s shell-degrade flow: an engine tab
   * degrading to a shell while it's the one on screen keeps the same
   * `taskId`, so the ordinary cwd/taskId-change path never fires). Ignored
   * on the initial mount.
   */
  resetToken?: Accessor<number>
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

  // Subscribe to whichever PTY is currently active. Own effect (keyed on
  // `pty()`) instead of inline with acquire so it reattaches whenever the
  // active PTY changes for any reason — task switch, reset, or recovery
  // after an external kill (wiring `onData` only in the acquire effect
  // left a `reset()`'s fresh PTY without a listener: input echoed to the
  // shell but never reached the snapshot signal).
  createEffect(() => {
    const handle = pty()
    const killed = handle ? handle.killed : false
    setExited(killed)
    if (!handle) return
    if (killed) {
      // Already dead by the time we mounted (e.g. re-selecting a
      // backgrounded ephemeral editor tab whose process quit while
      // unfocused) — fire onExit now, there's no live handle to attach
      // a listener to.
      props.onExit?.()
      return
    }
    const unsubscribeExit = handle.onExit(() => {
      setExited(true)
      props.onExit?.()
    })
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

  // Kill + fresh-acquire under the same `cwd`/`taskId` (shared by the F5
  // confirm below and the external `resetToken` bump) — reset the render
  // signals together so a stale snapshot/cursor never survives onto the
  // new PTY.
  const forceReacquire = (cwd: string, taskId: string, geometry: { cols: number; rows: number }): void => {
    try {
      const fresh = registry().reset(taskId, cwd, { ...geometry, command: props.command })
      setPty(fresh)
      setSnapshot([])
      setCursor(null)
      setScrollOffset(0)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setAcquireError(message)
    }
  }

  // External forced-reacquire (see `resetToken` doc above) — skipped on
  // the initial mount (`defer: true`) so a fresh Terminal doesn't reset
  // itself the instant it acquires its first PTY.
  createEffect(
    on(
      () => props.resetToken?.(),
      () => {
        const cwd = props.cwd()
        const taskId = props.taskId()
        const geometry = bodyGeometry()
        if (cwd && taskId && geometry) forceReacquire(cwd, taskId, geometry)
      },
      { defer: true },
    ),
  )

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
      // Only reset if the user is still on the same task — a
      // mid-confirm switch invalidates the operation.
      if (props.taskId() !== taskIdAtClick || props.cwd() !== cwdAtClick) return
      forceReacquire(cwdAtClick, taskIdAtClick, geometryAtClick)
    })
  }

  useTerminalBindings({
    focused,
    write: (data) => {
      const handle = pty()
      if (!handle || handle.killed) return
      handle.write(data)
    },
    paste: (text) => {
      const handle = pty()
      if (!handle || handle.killed) return
      handle.paste(text)
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

  // Cursor is rendered inline into the StyledText snapshot above (not
  // opentui's native host cursor) — one render path avoids a coordinate
  // split between typed spaces and cursorX. Focus hides the host cursor so
  // it can't leave a stale block on top of xterm-rendered text. We also
  // push the body's measured (cols, rows) to the backend via `pty.resize`.
  const renderer = useRenderer()
  // Reactive terminal dims — when the host window resizes, this changes
  // and re-fires effects that read the body's live `width/height`.
  const dims = useTerminalDimensions()

  // Layout-tick — bumped by the body box's real `onSizeChange` (fires once
  // Yoga computes a new size) so effects reading non-reactive geometry
  // (`ref.width/height`) catch up with layout changes that have no Solid
  // signal of their own (a splitter drag resizes the pane downstream of
  // the signal it mutates). A prior 1s-poll version left a remount's
  // first pre-layout `ref.width` read stuck for up to a second.
  const [geomTick, setGeomTick] = createSignal(0)
  const bumpGeomTick = (): void => {
    setGeomTick((n) => (n + 1) & 0xff)
  }

  // Track last pushed geometry so we don't fire `pty.resize` on every
  // re-render; real PTY backends may emit SIGWINCH even when geometry
  // is unchanged.
  let lastResize: { cols: number; rows: number } | null = null

  // Measure the rendered body's geometry before spawning the PTY — avoids
  // booting at the default 80x24 and immediately resizing, which makes
  // zsh/starship-style prompts redraw into stray standalone lines.
  createEffect(() => {
    const ref = bodyRef()
    // Read dims + geomTick so this effect re-runs when the host
    // terminal resizes OR a splitter drag changes our body size.
    dims()
    geomTick()
    if (!ref) return
    // Pre-layout guard: before Yoga's first pass the box reports 0 (or
    // junk) — flooring that into a "plausible" 20x4 and pushing it to an
    // already-running PTY forced the engine CLI to redraw tiny, leaving a
    // wrecked frame until the next real measurement. Skip until the box
    // has actually been laid out; onSizeChange re-fires this effect then.
    if (ref.width <= 0 || ref.height <= 0) return
    // Flush grid — the body carries no padding (owner feedback 2026-07-06:
    // the engine CLI owns its own gutters), so the full box width is usable.
    const cols = Math.max(20, ref.width)
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
    // Borderless by design: the workspace layout wrapper owns the focus
    // border (double borders otherwise); this pane is pure content.
    <box
      flexDirection="column"
      flexGrow={1}
      overflow="hidden"
      backgroundColor={theme.background}
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
        onSizeChange={bumpGeomTick}
        flexGrow={1}
        overflow="hidden"
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
          {/* One multi-line `<text>` for the whole snapshot (rows flattened
              with `\n`, see `rowsToStyledText`) — one <text> per row inside
              a flex column shifted body.screenY, landing the cursor a row
              above the prompt. opentui 0.4 also won't accept StyledText as
              a JSX child or through the content prop (stringifies it), so
              content is pushed via the TextRenderable ref + effect above. */}
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
