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
import { copyTextToSystemClipboard } from "../../lib/clipboard-copy"
import { useDialog } from "../../ui/dialog"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { useTerminalBindings } from "./keys"
import { type PtyRegistry, getDefaultPtyRegistry } from "./registry"
import { rowsToStyledText } from "./sgr-to-text-chunk"
import { isShellMissing } from "./terminal-render"
import { type CellPoint, type SelectionRange, extractSelection, overlaySelection } from "./terminal-selection"
import { useTerminalPty } from "./use-terminal-pty"
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
   * Ask the host to focus this pane (mouse click). Needed because opentui
   * mouse events don't bubble to the workspace wrapper's `onMouseUp`, and
   * this pane's own selection handlers consume the click — so a bare click
   * inside the terminal would never reach the global focus setter. The host
   * wires this to `focus.setFocused("workspace")`.
   */
  onRequestFocus?: () => void
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

  // Scroll offset: 0 = follow bottom; positive = N lines back into history.
  const [scrollOffset, setScrollOffset] = createSignal(0)

  const [bodyRef, setBodyRef] = createSignal<BoxRenderable | null>(null)
  const [bodyRows, setBodyRows] = createSignal(4)
  const [bodyGeometry, setBodyGeometry] = createSignal<{ cols: number; rows: number } | null>(null)

  /* --------- pty lifecycle (see use-terminal-pty.ts) ---------- */

  const { pty, snapshot, cursor, exited, acquireError, forceReacquire } = useTerminalPty({
    cwd: props.cwd,
    taskId: props.taskId,
    command: () => props.command,
    resetToken: props.resetToken,
    onExit: () => props.onExit?.(),
    registry,
    bodyGeometry,
    onFreshPty: () => setScrollOffset(0),
  })

  // Shared by the ctrl+pgup/pgdn chords and the mouse wheel. Contract:
  // positive `lines` moves toward newer output (offset shrinks back to
  // follow-bottom), negative moves up into history — tests assert this.
  // Clamped to the real history depth: an unbounded offset kept growing
  // past the top, so scrolling back down first had to "spin" through the
  // phantom distance before anything moved.
  const scrollBy = (lines: number): void => {
    const max = Math.max(0, snapshot().length - bodyRows())
    setScrollOffset((cur) => Math.min(max, Math.max(0, cur - lines)))
  }

  // Copy-on-select, GRID-based (tmux convention; see terminal-selection.ts
  // for why opentui's flow selection can't work over this pane). Anchor
  // and head live in absolute snapshot coordinates so the highlight
  // survives every frame refresh and scrollback move; releasing a drag
  // copies the cells the highlight showed — dual delivery via
  // clipboard-copy.ts (pbcopy pipe + OSC52). DECLARED BEFORE the render
  // memos: cursorRows reads selection() during its EAGER first
  // evaluation, and a later declaration is a TDZ crash.
  // cellFromEvent/copySelection only run from event
  // handlers, so their later-declared reads (renderer) are safe.
  const [selAnchor, setSelAnchor] = createSignal<CellPoint | null>(null)
  const [selHead, setSelHead] = createSignal<CellPoint | null>(null)
  let selDragging = false
  const selection = createMemo<SelectionRange | null>(() => {
    const anchor = selAnchor()
    const head = selHead()
    return anchor && head ? { anchor, head } : null
  })
  const cellFromEvent = (evt: { x?: number; y?: number }): CellPoint | null => {
    const body = bodyRef()
    const geometry = bodyGeometry()
    if (!body || !geometry) return null
    const col = Math.min(geometry.cols - 1, Math.max(0, (evt.x ?? 0) - body.screenX))
    const viewRow = Math.min(bodyRows() - 1, Math.max(0, (evt.y ?? 0) - body.screenY))
    return { row: visibleRange().start + viewRow, col }
  }
  const copySelection = (): void => {
    const range = selection()
    if (!range) return
    const text = extractSelection(snapshot(), range)
    if (text.trim().length > 0) copyTextToSystemClipboard(text, (t) => renderer.copyToClipboardOSC52(t))
  }

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
    scroll: scrollBy,
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

  // No inline inverse-cell cursor anymore — the visible cursor is the real
  // host cursor positioned in the focus effect above. We still overlay the
  // drag SELECTION highlight.
  const cursorRows = createMemo(() =>
    overlaySelection(visibleRows(), selection(), visibleRange().start, bodyGeometry()?.cols ?? 80),
  )

  // Flatten every visible row into ONE `StyledText` separated by
  // `\n`s. We render this as a single `<text>` element inside the
  // body so opentui's layout treats the body as a 1:1 cell grid —
  // crucial for the cursor positioning math (`body.screenY + c.y`).
  // Per-row `<text>` elements in a flex column don't keep `screenY`
  // aligned with pane row indexing (the cursor lands one row above
  // the visible prompt), hence the single element.
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
  // the signal it mutates). Event-driven, not polled — a poll leaves a remount's
  // first pre-layout `ref.width` read stuck for the poll interval.
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
    // Flush grid — the body carries no padding (the engine CLI owns its
    // own gutters), so the full box width is usable.
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

  // Show the native host cursor at the embedded cursor's SCREEN CELL — one
  // real cursor, matching native claude/codex. This replaces the inline
  // inverse-cell block (`cursorRows` no longer injects one): during CJK / IME
  // composition the OS candidate window anchors to the real cursor and the
  // preedit extends from it, so there's no second block cursor drifting
  // behind the text the user is typing. `cursor.x` is a CELL column, so
  // `screenX + cursor.x` is inherently wide-char correct. Reading
  // visibleCursor()/geomTick()/dims() re-runs this as the cursor moves or the
  // pane resizes; screenX/screenY are read imperatively (non-reactive
  // geometry, same as the resize effect). Hidden when unfocused or the cursor
  // is scrolled out of view, so it can't leak onto another pane.
  createEffect(() => {
    const body = bodyRef()
    const c = focused() ? visibleCursor() : null
    geomTick()
    dims()
    if (c && body && body.width > 0) {
      renderer.setCursorPosition(body.screenX + c.x, body.screenY + c.y, true)
    } else {
      renderer.setCursorPosition(0, 0, false)
    }
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
      onMouseDown={(evt) => {
        if ((evt as { button?: number }).button !== 0) return
        // Focus on press — clicking anywhere in the terminal focuses the
        // pane, even if the click isn't a text-selection drag.
        props.onRequestFocus?.()
        const cell = cellFromEvent(evt as { x?: number; y?: number })
        if (!cell) return
        selDragging = true
        setSelAnchor(cell)
        setSelHead(cell)
      }}
      onMouseDrag={(evt) => {
        if (!selDragging) return
        const cell = cellFromEvent(evt as { x?: number; y?: number })
        if (cell) setSelHead(cell)
      }}
      onMouseUp={() => {
        setFocusedLocal(true)
        props.onRequestFocus?.()
        if (!selDragging) return
        selDragging = false
        const anchor = selAnchor()
        const head = selHead()
        if (anchor && head && (anchor.row !== head.row || anchor.col !== head.col)) {
          // Real drag: copy and keep the highlight (cleared on next click).
          copySelection()
        } else {
          // Plain click: clear any previous selection.
          setSelAnchor(null)
          setSelHead(null)
        }
      }}
      onMouseScroll={(evt) => {
        // Native terminal wheel semantics, in emulator order: the app
        // enabled mouse tracking → forward the wheel (claude/vim scroll
        // themselves); fullscreen app without it → arrow-key fallback
        // (both inside pty.wheel); ONLY otherwise scroll kobe's local
        // scrollback, like a normal terminal over a plain shell.
        const e = evt as { x?: number; y?: number; scroll?: { direction: string; delta: number } }
        const scroll = e.scroll
        if (!scroll || (scroll.direction !== "up" && scroll.direction !== "down")) return
        const handle = pty()
        const body = bodyRef()
        if (handle && !handle.killed && body) {
          const col = Math.max(1, (e.x ?? 0) - body.screenX + 1)
          const row = Math.max(1, (e.y ?? 0) - body.screenY + 1)
          if (handle.wheel(scroll.direction, col, row)) return
        }
        // One line per event: opentui's parser emits delta:1 per wheel
        // tick and the host terminal already granulates trackpad flicks
        // into a stream of ticks — multiplying here compounded to 3x
        // speed and overshot the target.
        const step = Math.max(1, scroll.delta || 1)
        scrollBy(scroll.direction === "up" ? -step : step)
      }}
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
