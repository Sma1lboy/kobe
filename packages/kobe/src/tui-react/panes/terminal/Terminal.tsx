/** @jsxImportSource @opentui/react */
/**
 * Embedded terminal pane — React port of `tui/panes/terminal/Terminal.tsx`
 * (issue #16 React migration). Same seam: the KOBE_TUI workspace host
 * mounts it as the center column running the task's real interactive
 * engine CLI (its `command` prop); it also works as a plain worktree
 * shell. Body: a headless xterm screen snapshot fed by the task PTY,
 * clipped via opentui's `overflow` + viewport slicing.
 *
 * Shared framework-free logic (PTY backend, key encoding, SGR→StyledText,
 * viewport math, grid selection) is imported straight from the Solid
 * cluster `tui/panes/terminal/*` — this file (plus its `use-terminal-*`
 * hooks) owns only the React reactivity. See the Solid original for the
 * full lifecycle rationale (acquire/subscribe contract, never-kill-on-
 * unmount, dead-shell banner, F5 reset). Deltas below.
 *
 * Solid→React translation notes:
 *   - `cwd`/`taskId`/`focused`/`resetToken` are plain values, not
 *     Accessors — React re-renders on prop change.
 *   - The Solid original's declaration-order comment ("selection memo
 *     BEFORE the render memos — cursorRows reads selection() during its
 *     EAGER first evaluation, a later declaration is a TDZ crash") is a
 *     Solid-specific hazard: `createMemo` evaluates eagerly at
 *     declaration time there. React's `useMemo` evaluates lazily off a
 *     dependency array during render, so no such ordering constraint
 *     exists — the hooks below are ordered for readability, not
 *     correctness.
 *   - Body-box measurement lives in `use-terminal-geometry.ts`; the
 *     resize-push-to-pty and host-cursor-anchor effects stay HERE
 *     because they need the PTY handle and the computed viewport cursor,
 *     which only exist after the geometry hook's `bodyGeometry` has fed
 *     `useTerminalPty` — splitting them out would just reintroduce the
 *     same chicken-and-egg hook ordering this file avoids.
 */

import type { BoxRenderable, TextRenderable } from "@opentui/core"
import { StyledText } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { type PtyRegistry, getDefaultPtyRegistry } from "../../../tui/panes/terminal/registry"
import { rowsToStyledText } from "../../../tui/panes/terminal/sgr-to-text-chunk"
import { isShellMissing, overlayCursor } from "../../../tui/panes/terminal/terminal-render"
import { overlaySelection } from "../../../tui/panes/terminal/terminal-selection"
import { computeViewport, viewportCursor } from "../../../tui/panes/terminal/viewport"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"
import { useDialog } from "../../ui/dialog"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { useTerminalBindings } from "./keys"
import { useTerminalGeometry } from "./use-terminal-geometry"
import { useTerminalPty } from "./use-terminal-pty"
import { useTerminalSelection } from "./use-terminal-selection"

/* --------------------------------------------------------------------- */
/*  Public surface                                                        */
/* --------------------------------------------------------------------- */

export type TerminalProps = {
  /** Working dir for the shell. Null disables the pane (no task). */
  cwd: string | null
  /** Stable id used for pty registry keying. */
  taskId: string | null
  focused?: boolean
  /**
   * Ask the host to focus this pane (mouse click). Needed because opentui
   * mouse events don't bubble to the workspace wrapper's `onMouseUp`, and
   * this pane's own selection handlers consume the click — so a bare click
   * inside the terminal would never reach the global focus setter.
   */
  onRequestFocus?: () => void
  /**
   * Override the embedded process argv. When set the pane runs this
   * command instead of an interactive shell — e.g. `["claude"]` to make
   * this a PTY view of an interactive Claude Code session.
   */
  command?: readonly string[]
  /**
   * Fires once when the PTY reports exit (or is already dead at mount) —
   * `undefined` for the default "leave the dead shell + exit banner up"
   * behavior. Used by `TerminalTabs.tsx` to auto-close command tabs and
   * to degrade engine tabs to a shell.
   */
  onExit?: () => void
  /**
   * Bump this to force a fresh PTY acquire under the SAME `cwd`/`taskId`
   * — for a caller whose underlying command changed without the pty key
   * changing. Ignored on the initial mount.
   */
  resetToken?: number
  /** Optional registry override (tests inject a mock-backed registry). */
  registry?: PtyRegistry
}

/* --------------------------------------------------------------------- */
/*  Component                                                             */
/* --------------------------------------------------------------------- */

export function Terminal(props: TerminalProps) {
  const { theme } = useTheme()
  const t = useT()
  const registry = props.registry ?? getDefaultPtyRegistry()

  // Local "focus" — the pane manages its own focus on click unless the
  // caller drives it via `props.focused` (behavior tests).
  const [focusedLocal, setFocusedLocal] = useState(false)
  const focused = props.focused ?? focusedLocal

  // Scroll offset: 0 = follow bottom; positive = N lines back into history.
  const [scrollOffset, setScrollOffset] = useState(0)

  const { bodyEl, setBodyEl, bodyRows, bodyGeometry, bumpGeomTick, dims, geomTick } = useTerminalGeometry()

  const { pty, snapshot, cursor, exited, acquireError, forceReacquire } = useTerminalPty({
    cwd: props.cwd,
    taskId: props.taskId,
    command: props.command,
    resetToken: props.resetToken,
    onExit: props.onExit,
    registry,
    bodyGeometry,
    onFreshPty: () => setScrollOffset(0),
  })

  // Shared by the ctrl+pgup/pgdn chords and the mouse wheel. Positive
  // `lines` moves toward newer output, negative moves up into history.
  // Clamped to the real history depth.
  const scrollBy = (lines: number): void => {
    const max = Math.max(0, snapshot.length - bodyRows)
    setScrollOffset((cur) => Math.min(max, Math.max(0, cur - lines)))
  }

  /* --------- viewport slicing ---------- */

  // Rows visible after applying scroll offset. offset 0 means
  // follow-bottom: render only the last body-height rows.
  const visibleRange = useMemo(
    () => computeViewport(snapshot.length, bodyRows, scrollOffset),
    [snapshot.length, bodyRows, scrollOffset],
  )
  const visibleRows = useMemo(() => snapshot.slice(visibleRange.start, visibleRange.end), [snapshot, visibleRange])
  // Cursor is only meaningful when following the bottom of the buffer;
  // once scrolled back, the live (x,y) refers to the LIVE viewport.
  const visibleCursor = useMemo(
    () => viewportCursor(cursor, scrollOffset, visibleRange),
    [cursor, scrollOffset, visibleRange],
  )

  /* --------- selection ---------- */

  const selection = useTerminalSelection({
    bodyEl,
    bodyGeometry,
    bodyRows,
    visibleRangeStart: visibleRange.start,
    snapshot,
  })

  const cursorRows = useMemo(() => {
    const withSelection = overlaySelection(
      visibleRows,
      selection.selection,
      visibleRange.start,
      bodyGeometry?.cols ?? 80,
    )
    return overlayCursor(withSelection, focused ? visibleCursor : null)
  }, [visibleRows, selection.selection, visibleRange.start, bodyGeometry, focused, visibleCursor])

  // Flatten every visible row into ONE `StyledText` — see the Solid
  // original for why a single element (not per-row `<text>`s) is load-
  // bearing for the cursor positioning math.
  const styledSnapshot = useMemo(() => new StyledText(rowsToStyledText(cursorRows)), [cursorRows])

  // Imperative content push — opentui 0.4 won't accept StyledText as a
  // JSX child or through the content prop (stringifies it).
  const [snapshotTextEl, setSnapshotTextEl] = useState<TextRenderable | null>(null)
  useEffect(() => {
    if (snapshotTextEl) snapshotTextEl.content = styledSnapshot
  }, [snapshotTextEl, styledSnapshot])

  /* --------- reset (F5, confirm-gated) ---------- */

  const dialog = useDialog()
  const requestReset = (): void => {
    if (!pty) return
    // Snapshot at click-time so a task switch mid-confirm doesn't reset
    // the wrong shell.
    const cwdAtClick = props.cwd
    const taskIdAtClick = props.taskId
    const geometryAtClick = bodyGeometry
    if (!cwdAtClick || !taskIdAtClick || !geometryAtClick) return
    void DialogConfirm.show(dialog, t("terminal.reset.title"), t("terminal.reset.body"), "cancel").then((ok) => {
      if (ok !== true) return
      if (props.taskId !== taskIdAtClick || props.cwd !== cwdAtClick) return
      forceReacquire(cwdAtClick, taskIdAtClick, geometryAtClick)
    })
  }

  useTerminalBindings({
    focused,
    write: (data) => {
      if (!pty || pty.killed) return
      pty.write(data)
    },
    paste: (text) => {
      if (!pty || pty.killed) return
      pty.paste(text)
    },
    scroll: scrollBy,
    reset: requestReset,
  })

  /* --------- resize-push + host-cursor anchor ---------- */

  const renderer = useRenderer()

  // Push geometry changes to the backend, deduped against the last push —
  // real PTY backends may emit SIGWINCH even when geometry is unchanged.
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null)
  useEffect(() => {
    if (!pty || !bodyGeometry) return
    const { cols, rows } = bodyGeometry
    const last = lastResizeRef.current
    if (last && last.cols === cols && last.rows === rows) return
    lastResizeRef.current = { cols, rows }
    try {
      pty.resize(cols, rows)
    } catch {
      /* best effort */
    }
  }, [pty, bodyGeometry])

  // Keep the native host cursor INVISIBLE (the visible cursor is the
  // inline inverse cell in `cursorRows`) but ANCHORED to the embedded
  // cursor's screen cell — the OS IME candidate window follows the real
  // terminal cursor. Falls back to origin when scrolled out of view or
  // not yet laid out.
  useEffect(() => {
    // Dependency-only invalidation keys — see use-terminal-geometry.ts;
    // screenX/screenY are read imperatively, non-reactive geometry.
    void dims
    void geomTick
    if (!renderer) return
    if (!focused) return
    if (bodyEl && visibleCursor && bodyEl.width > 0) {
      renderer.setCursorPosition(bodyEl.screenX + visibleCursor.x, bodyEl.screenY + visibleCursor.y, false)
    } else {
      renderer.setCursorPosition(0, 0, false)
    }
  }, [renderer, focused, bodyEl, visibleCursor, dims, geomTick])

  // On unmount, hide the cursor so it doesn't leak into whichever pane
  // gains focus next.
  useEffect(() => {
    return () => {
      try {
        renderer?.setCursorPosition(0, 0, false)
      } catch {
        /* renderer may already be torn down */
      }
    }
  }, [renderer])

  /* --------- view ---------- */

  return (
    // Borderless by design: the workspace layout wrapper owns the focus
    // border; this pane is pure content.
    <box
      flexDirection="column"
      flexGrow={1}
      overflow="hidden"
      backgroundColor={theme.background}
      onMouseDown={(evt) => {
        if (evt.button !== 0) return
        // Focus on press — but ONLY when not already focused, so clicking
        // inside a focused terminal is a pure no-op. A text-selection
        // drag still works regardless.
        if (!focused) props.onRequestFocus?.()
        const cell = selection.cellFromEvent(evt)
        if (!cell) return
        selection.beginSelection(cell)
      }}
      onMouseDrag={(evt) => {
        const cell = selection.cellFromEvent(evt)
        if (cell) selection.updateSelectionHead(cell)
      }}
      onMouseUp={() => {
        setFocusedLocal(true)
        if (!selection.isDragging()) return
        selection.endDragging()
        if (selection.selection) {
          // Real drag: copy and keep the highlight (cleared on next click).
          selection.copySelection()
        } else {
          // Plain click: clear any previous selection.
          selection.clearSelection()
        }
      }}
      onMouseScroll={(evt) => {
        // Native terminal wheel semantics, in emulator order: the app
        // enabled mouse tracking → forward the wheel; fullscreen app
        // without it → arrow-key fallback (both inside pty.wheel); ONLY
        // otherwise scroll kobe's local scrollback.
        const scroll = evt.scroll
        if (!scroll || (scroll.direction !== "up" && scroll.direction !== "down")) return
        if (pty && !pty.killed && bodyEl) {
          const col = Math.max(1, evt.x - bodyEl.screenX + 1)
          const row = Math.max(1, evt.y - bodyEl.screenY + 1)
          if (pty.wheel(scroll.direction, col, row)) return
        }
        // One line per event — opentui's parser emits delta:1 per wheel
        // tick already granulated by the host terminal.
        const step = Math.max(1, scroll.delta || 1)
        scrollBy(scroll.direction === "up" ? -step : step)
      }}
    >
      {/* Scroll affordance — only rendered when scrolled back into
          history, so the body's screenY equals the pane's content top in
          the steady state (the cursor math depends on that). */}
      {exited ? (
        <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
          <text fg={theme.error} wrapMode="none">
            {t("terminal.exited")}
          </text>
        </box>
      ) : null}
      {scrollOffset > 0 ? (
        <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
          <text fg={theme.warning} wrapMode="none">
            {t("terminal.scrolledBack", { lines: scrollOffset })}
          </text>
        </box>
      ) : null}

      <box ref={(r: BoxRenderable | null) => setBodyEl(r)} onSizeChange={bumpGeomTick} flexGrow={1} overflow="hidden">
        {/* Body */}
        {pty ? (
          // One multi-line `<text>` for the whole snapshot (rows flattened
          // with `\n`) — one <text> per row inside a flex column shifts
          // body.screenY, landing the cursor a row above the prompt.
          <text fg={theme.text} wrapMode="none" ref={(r: TextRenderable | null) => setSnapshotTextEl(r)} />
        ) : (
          <box paddingLeft={1} paddingTop={1} flexDirection="column" gap={0}>
            {acquireError ? (
              <>
                <text fg={theme.error} wrapMode="word">
                  {isShellMissing(acquireError)
                    ? t("terminal.unavailable.shellMissing")
                    : t("terminal.unavailable.spawnFailed")}
                </text>
                <text fg={theme.textMuted} wrapMode="word">
                  {acquireError}
                </text>
              </>
            ) : (
              <text fg={theme.textMuted}>{t("terminal.noTask")}</text>
            )}
          </box>
        )}
      </box>
    </box>
  )
}
