/**
 * Terminal pane (Stream J) — bottom-right of the Conductor layout.
 *
 * Renders an embedded shell scoped to the active task's worktree.
 * Header: `terminal — <cwd-basename>`. Body: SGR-rendered scrollback
 * (colors, bold/italic/underline) with a native viewport cursor.
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
 * Output rendering: tmux gives us full pane snapshots, not deltas.
 * Snapshots come from `capture-pane -e` (SGR-preserving) so colors
 * and attributes survive; cursor-motion and other control codes were
 * already applied to tmux's grid before capture. The snapshot is fed
 * through `./sgr.ts` which returns one chunk-list per row. Each row
 * renders as its own `<text>` carrying a `StyledText` of those
 * chunks — opentui composes the per-cell fg/bg/attrs from there.
 *
 * Scrollback / viewport: we keep the latest snapshot in a Solid
 * signal, parse it into chunks, and slice to the visible window.
 * `ctrl+pgup`/`ctrl+pgdown` shift a `scrollOffset` signal; when
 * offset is 0 we follow the bottom (so new output is always visible
 * by default).
 *
 * Cursor race: an earlier polling-only design caught fancy prompts
 * mid-repaint and rendered the cursor one row above the visible
 * prompt. The current model has `TmuxControlClient` (push-based via
 * `tmux -CC`) wake `TmuxTaskPty` whenever the shell wrote output,
 * with a debounce so capture only fires after a quiet window — see
 * `./pty.ts`. The cursor (x, y) we render is always paired with a
 * stable end-state snapshot.
 */

import { basename } from "node:path"
import { type BoxRenderable, StyledText, TextAttributes } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import {
  type Accessor,
  For,
  type JSXElement,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js"
import { useTheme } from "../../context/theme"
import { useTerminalBindings } from "./keys"
import type { CursorPos, TaskPty } from "./pty"
import { PtyRegistry } from "./registry"
import { parseAnsiSnapshot } from "./sgr"
import { toTextChunk } from "./sgr-to-text-chunk"

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

      // Subscribe; the listener receives `(snapshot, cursor)` from a
      // single atomic tmux roundtrip — they describe the SAME grid
      // state, so we never display a stale cursor on a fresh snapshot.
      // The snapshot now carries SGR escapes (tmux capture-pane -e);
      // we keep them verbatim because the SGR parser in `./sgr.ts`
      // turns them into per-cell color spans at render time.
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

  // Parse the snapshot (text + SGR escapes) into one chunk-list per
  // row. Memoized on `snapshot()`, so a cursor-only update doesn't
  // re-parse the (unchanged) text. Empty rows are preserved so the
  // tmux-reported `cursor.y` indexes into this array 1:1.
  const parsedRows = createMemo(() => parseAnsiSnapshot(snapshot()))

  // Per-row `StyledText` view used by the body's `<For>` render. We
  // produce one StyledText per row instead of N <span>s per cell —
  // opentui's <text> efficiently consumes a single chunks array.
  // `toTextChunk` is the thin adapter that maps `sgr.ts`'s
  // opentui-free Chunk into the RGBA-flavored TextChunk opentui
  // wants.
  const styledRows = createMemo(() =>
    parsedRows().map((chunks) => {
      // An empty row is still a meaningful position (blank line in
      // the pane). We emit a StyledText with a single empty chunk so
      // the row's `<text>` still renders and occupies one line.
      if (chunks.length === 0) return new StyledText([{ __isChunk: true, text: "" }])
      return new StyledText(chunks.map(toTextChunk))
    }),
  )

  // Lines visible after applying scroll offset. We slice off the
  // bottom `scrollOffset` rows so scrolling back reveals older
  // content; offset 0 means "show everything = follow live".
  const visibleStyledRows = createMemo(() => {
    const all = styledRows()
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
  const [bodyRef, setBodyRef] = createSignal<BoxRenderable | null>(null)
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
  // a per-frame callback here — it triggered tmux `resize-window` every
  // frame, and the resulting SIGWINCH storm made p10k / pure / oh-my-zsh
  // re-emit their prompt several times on mount.
  const [geomTick, setGeomTick] = createSignal(0)
  const geomTimer = setInterval(() => {
    setGeomTick((n) => (n + 1) & 0xff)
  }, 250)
  onCleanup(() => clearInterval(geomTimer))

  // Track last pushed geometry so we don't fire `pty.resize` on every
  // re-render — tmux re-applying the same dims still sends SIGWINCH and
  // makes prompt-rendering shells (oh-my-zsh, p10k) reprint their
  // prompt, which surfaces as spurious empty `>` lines on mount.
  let lastResize: { cols: number; rows: number } | null = null

  // Push the rendered body's geometry to tmux so cursor coords align.
  createEffect(() => {
    const handle = pty()
    const ref = bodyRef()
    // Read dims + geomTick so this effect re-runs when the host
    // terminal resizes OR a splitter drag changes our body size.
    dims()
    geomTick()
    if (!handle || !ref) return
    // Subtract the body's own paddingLeft/paddingRight (1+1) from the
    // usable width so the shell doesn't try to write into the padding.
    const cols = Math.max(20, ref.width - 2)
    const rows = Math.max(4, ref.height)
    if (lastResize && lastResize.cols === cols && lastResize.rows === rows) return
    lastResize = { cols, rows }
    try {
      handle.resize(cols, rows)
    } catch {
      /* best effort — resize fails silently in tmux when geometry is unchanged */
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
    const c = cursor()
    if (!showCursor() || !c) {
      // Hide the cursor by parking it off-screen with visible=false.
      renderer.setCursorPosition(0, 0, false)
      return
    }
    // Make sure the host terminal actually draws something — some
    // emulators default to a hidden cursor inside alt-screen until a
    // style is explicitly set. Block + blinking matches what a normal
    // shell looks like, so the user sees the same affordance they'd
    // see typing into bash directly.
    try {
      renderer.setCursorStyle({ style: "block", blinking: true })
    } catch {
      /* older opentui versions may not expose setCursorStyle; ignore */
    }
    // body has paddingLeft=1, so column 0 of the snapshot is at screenX+1.
    // Cursor coords are 0-based pane row/col, atomically captured with
    // the snapshot. Now that the PTY constructor forces the detached
    // session's `window-size` to `manual`, tmux's pane grid actually
    // matches our body height — so cursor_y indexes our rendered lines
    // 1:1 and no off-by-one fudge is needed.
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
      borderColor={focused() ? theme.focusAccent : theme.border}
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
            <Show when={acquireError()} fallback={<text fg={theme.textMuted}>(no task — press n to create)</text>}>
              <text fg={theme.error} wrapMode="word">
                terminal unavailable —{" "}
                {isTmuxMissing(acquireError() ?? "")
                  ? "tmux is not installed (try `brew install tmux` or set KOBE_TMUX_BIN)"
                  : "shell could not start"}
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
            setBodyRef(r)
          }}
          flexGrow={1}
          paddingLeft={1}
          paddingRight={1}
          flexDirection="column"
        >
          {/* One <text> per row. Each row carries its own StyledText
              built from the SGR-parsed chunks of that row, so colors
              and attributes render natively. We render per-row (not
              one big multi-line <text>) so the chunks array doesn't
              have to encode line breaks — that was the old plain-text
              approach and it lost the per-cell color shape. The cursor
              still lands at (screenX + 1 + x, screenY + y) via the
              renderer's native cursor (see createEffect below); the
              column flex layout means row N maps to screenY + N
              regardless of how each row's chunks lay out. */}
          <For each={visibleStyledRows()}>
            {(row) => (
              <text fg={theme.text} wrapMode="none">
                {row}
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
