/**
 * kobe preview pane (Stream I) — center-top of the Conductor layout.
 *
 * Multi-tab file/diff viewer:
 *   - Tab bar at the top: one tab per opened file with an `x` close button.
 *   - Mode toggle in the header — `f` (File) shows raw content, `d` (Diff)
 *     runs `git diff <base>` and renders via `DiffLine`. Default mode is
 *     Diff when the file is in `git status` AND `diffBase` is set,
 *     otherwise File. Per-tab mode (state.ts) so each tab remembers.
 *   - Scrollable body. Long files use opentui's `<scrollbox>` rather
 *     than truncating — the brief explicitly requires this for v1.
 *   - Empty state: "Open a file from the tree (enter)".
 *
 * Imperative API: parent passes an `onOpen(api)` callback. We invoke it
 * once at mount with `{ open(path), close(path) }`. The parent (Stream H
 * file tree, then the orchestrator) calls those to drive the pane —
 * matches the contract block in the brief.
 *
 * State split:
 *   - `state.ts` owns the immutable tab list / active index / per-tab
 *     mode + scroll. Pure; unit-tested.
 *   - This component holds the `[state, setState]` Solid signal and
 *     re-runs file/diff fetches when the active tab or mode changes.
 *   - `keys.ts` registers pane-local bindings via `useBindings`.
 *
 * Why `createEffect` (not `createResource`) for fetches: the data
 * source is a synchronous `spawnSync` (see diff.ts) wrapped in
 * `Promise.resolve` for API symmetry. Effect + signal is the simplest
 * cycle: dependencies are `(activeTab, mode)`, output is a content
 * signal the renderer reads. `createResource`'s loading/error machinery
 * adds noise we don't need at this scale.
 */

import { RGBA, type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import {
  type Accessor,
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js"
import { useTheme } from "../../context/theme"
import { DiffLine, FileLine } from "./DiffLine"
import { isPathChanged, readDiff, readFile, readHeaderBytes, splitLines, statFile } from "./diff"
import {
  type DecodedImage,
  type DecodedImageSequence,
  computeTargetDims,
  decodeAnimatedImage,
  decodeImage,
  decodePdfFirstPage,
  decodeVideoFirstFrame,
  probeFrameTiming,
  probeMediaDims,
} from "./image-render"
import { usePreviewBindings } from "./keys"
import {
  type ImageDims,
  type ImageFormat,
  type MediaKind,
  detectMediaKind,
  formatBytes,
  parseImageHeader,
} from "./media"
import {
  EMPTY_STATE,
  type PreviewMode,
  type PreviewState,
  type PreviewTab,
  activeTab,
  closeTab,
  moveActive,
  openTab,
  setActiveMode,
  setActiveScroll,
  tabLabel,
} from "./state"
import { type XmlToken, splitTokensByLine, tokenizeXml } from "./xml-highlight"

/** Public props — matches the contract in the brief verbatim. */
export type PreviewProps = {
  worktreePath: Accessor<string | null>
  diffBase: Accessor<string | null>
  onOpen?: (api: PreviewApi) => void
  focused?: Accessor<boolean>
  /**
   * Hide the internal tab strip. When true, the parent owns tab UX
   * (e.g. CenterTabs in `app.tsx` exposes a unified `chat | files…`
   * strip). Preview still tracks open files internally for the active-
   * file body — the parent drives state via the imperative {@link PreviewApi}.
   */
  hideInternalTabs?: Accessor<boolean>
  /**
   * Called when the user presses `ctrl+w` while `hideInternalTabs` is
   * true. The parent owns the tab strip in that mode, so closing has
   * to delegate back. Receives the active tab's path. No-op default
   * keeps the binding harmless when the parent doesn't care.
   */
  onExternalClose?: (relPath: string) => void
}

/** Imperative API the parent drives. Stable for the component's lifetime. */
export type PreviewApi = {
  open(relPath: string): void
  close(relPath: string): void
}

/**
 * Page-key unit for pgup/pgdn. The scrollbox itself flex-grows to fill
 * the parent (so a single file expands top-to-bottom), but pgup/pgdn
 * needs a constant cell count that doesn't depend on a measurable
 * viewport. 20 lines matches dialog-diff's choice and is roughly a
 * reasonable terminal half-screen.
 */
const PAGE_LINES = 20

/** Half-block character (U+2580): fg paints the upper half, bg the lower. */
const HALF_BLOCK_UPPER = "▀"

/**
 * Compute a half-block image budget that scales with the terminal size.
 *
 * The preview pane shares the row with the sidebar (42 cells) and the
 * file tree (38 cells, FILETREE_WIDTH in `filetree/FileTree.tsx`).
 * Whatever's left is the center column, minus a few cells for padding
 * around the card. Vertically we reserve roughly half the terminal —
 * the chat panel below the workspace and the metadata-card lines need
 * to stay readable, and an image that scrolls off-screen defeats the
 * point of an inline preview.
 *
 * Falls back to a conservative fixed budget when stdout isn't a TTY
 * (the test runner most commonly).
 */
const SIDEBAR_RESERVED_COLS = 42
const FILETREE_RESERVED_COLS = 38
const PANE_PADDING_COLS = 6
const PANE_HEADROOM_ROWS = 14

function computeImageBudget(): { maxCols: number; maxRows: number } {
  const out = process.stdout as { columns?: number; rows?: number }
  const termCols = typeof out.columns === "number" && out.columns > 0 ? out.columns : 120
  const termRows = typeof out.rows === "number" && out.rows > 0 ? out.rows : 40
  const maxCols = Math.max(20, termCols - SIDEBAR_RESERVED_COLS - FILETREE_RESERVED_COLS - PANE_PADDING_COLS)
  const maxRows = Math.max(10, Math.floor((termRows - PANE_HEADROOM_ROWS) / 2))
  return { maxCols, maxRows }
}

/**
 * `media` is the metadata card shown for binary file types we recognise
 * by extension (images, video, audio, pdf, archives…). We never dump
 * binary bytes through the text pipeline — the card gives the user
 * enough context (type, size, mtime, image dimensions when parseable)
 * to decide whether to open the file externally. KOB-14.
 *
 * For images we also try a half-block inline render via ffmpeg
 * (slice 2). `decoded` is undefined while loading, set to a
 * {@link DecodedImage} on success, and stays undefined on failure —
 * the metadata card alone is the fallback in that case.
 */
type MediaContent = {
  readonly relPath: string
  readonly kind: MediaKind
  readonly size: number
  readonly mtime: Date
  readonly dims?: ImageDims
  readonly decoded?: DecodedImage
  /** Animated frames for GIFs; if set, MediaBody flips through them on a timer. */
  readonly animation?: DecodedImageSequence
}

type ContentState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "lines"; lines: string[]; mode: PreviewMode }
  | { kind: "media"; media: MediaContent }
  | { kind: "xml"; rows: XmlToken[][] }

/**
 * Boil a `readFile` / `readDiff` error string down to something the
 * user can act on. The wrappers themselves emit shapes like
 * `cat: foo.bin: No such file or directory` and
 * `git diff <base> ... exited 128: fatal: ambiguous argument 'main'`.
 * Stripping the binary name + leading prefix keeps the line short
 * enough to show without wrapping in narrow preview panes.
 */
export function summarizePreviewError(raw: string): string {
  const m = raw.toLowerCase()
  if (m.includes("no such file") || m.includes("enoent")) return "file not found (rebased away?)"
  if (m.includes("permission denied") || m.includes("eacces")) return "permission denied"
  if (m.includes("ambiguous argument") || m.includes("unknown revision"))
    return "diff base does not resolve in this worktree"
  if (m.includes("path escapes worktree")) return "refused: path escapes worktree"
  if (m.includes("no worktree")) return "no active worktree"
  // Fallback: strip a `prog: path: ` prefix if present.
  const trimmed = raw.replace(/^([a-z0-9_-]+:\s+){1,2}/i, "").trim()
  return trimmed || "could not read file"
}

/**
 * Cheap binary sniff: any NUL byte in the first 8 KiB. Matches what
 * `git diff` uses internally and is good enough for the TUI — text
 * files are virtually never NUL-bearing, image/zip/wasm payloads
 * always are.
 */
function looksBinary(text: string): boolean {
  const probe = text.length > 8192 ? text.slice(0, 8192) : text
  return probe.indexOf("\u0000") >= 0
}

export function Preview(props: PreviewProps) {
  const { theme } = useTheme()

  const focusedAccessor = () => (props.focused ? props.focused() : true)

  // Tab list + active index live here as a single immutable snapshot;
  // every mutation goes through `state.ts`'s pure helpers. The Solid
  // signal wraps the snapshot ref so reactivity tracks at the snapshot
  // level (no fine-grained store needed for ~tens of tabs).
  const [state, setState] = createSignal<PreviewState>(EMPTY_STATE)

  // Async-content snapshot for the active tab. Re-derives whenever the
  // active tab path or mode changes. Held in a separate signal so the
  // render path doesn't await — the body shows a loading state during
  // refresh.
  const [content, setContent] = createSignal<ContentState>({ kind: "empty" })

  // Scrollbox ref so keys.ts can imperatively scroll. The ref callback
  // is invoked by opentui after mount; we close over the latest ref via
  // a closure variable.
  let scroll: ScrollBoxRenderable | undefined

  /**
   * Open a tab for `path` and pick a sensible default mode based on
   * `diffBase` + `git status`. We can't await inside `open()` (the
   * imperative API is synchronous), so we open with a provisional mode
   * and asynchronously upgrade to Diff if appropriate.
   */
  function openPath(relPath: string): void {
    if (!relPath) return
    setState((s) => openTab(s, relPath, "file"))
    const base = props.diffBase()
    const wt = props.worktreePath()
    if (!base || !wt) return
    void isPathChanged(wt, relPath).then((changed) => {
      if (!changed) return
      // Only flip if the user is still looking at this tab in default
      // mode — don't stomp explicit `f`/`d` toggles.
      setState((s) => {
        const cur = activeTab(s)
        if (!cur || cur.path !== relPath) return s
        if (cur.mode !== "file") return s
        return setActiveMode(s, "diff")
      })
    })
  }

  function closePath(relPath: string): void {
    if (!relPath) return
    setState((s) => closeTab(s, relPath))
  }

  // Expose the imperative API to the parent on mount. The brief allows a
  // ref-like callback rather than a forwardRef — simpler in Solid where
  // refs aren't first-class for non-renderable shapes.
  onMount(() => {
    props.onOpen?.({ open: openPath, close: closePath })
  })

  const tabs = createMemo<readonly PreviewTab[]>(() => state().tabs)
  const active = createMemo<PreviewTab | undefined>(() => activeTab(state()))

  /**
   * Re-fetch content whenever the active tab path or mode changes. We
   * track `(path, mode)` explicitly so changing scroll or other tab
   * fields doesn't trigger a refetch.
   */
  createEffect(
    on(
      () => {
        const cur = active()
        if (!cur) return null
        return { path: cur.path, mode: cur.mode }
      },
      async (key) => {
        if (!key) {
          setContent({ kind: "empty" })
          return
        }
        const wt = props.worktreePath()
        if (!wt) {
          setContent({ kind: "error", message: "no active worktree (open a task first)" })
          return
        }
        setContent({ kind: "loading" })

        // Known media types (images, video, pdf, audio, archives…) never
        // go through the text pipeline in either mode — KOB-14. We render
        // a metadata card with type, size, mtime, and parsed dimensions
        // when available, plus an inline half-block preview for the
        // kinds where it makes sense (image / video first-frame / pdf
        // first-page). SVG is XML and falls through to the text path
        // below.
        const mediaKind = detectMediaKind(key.path)
        const canPreview =
          mediaKind.kind === "image" ||
          mediaKind.kind === "video" ||
          mediaKind.kind === "pdf" ||
          mediaKind.kind === "binary"
        if (canPreview) {
          const s = await statFile(wt, key.path)
          if (!s.ok) {
            setContent({ kind: "error", message: summarizePreviewError(s.error) })
            return
          }
          // Header-parsed image dims when we have a known format. Video
          // and PDF dims are filled in via ffprobe / pdftoppm asynchronously
          // alongside the inline render.
          let dims: ImageDims | undefined
          if (mediaKind.kind === "image") {
            const h = await readHeaderBytes(wt, key.path, 32 * 1024)
            if (h.ok) {
              const parsed = parseImageHeader(h.buf, mediaKind.format)
              if (parsed) dims = parsed
            }
          }
          // Set the metadata card first so the user sees something
          // immediately while ffmpeg / pdftoppm works in the background.
          setContent({
            kind: "media",
            media: { relPath: key.path, kind: mediaKind, size: s.size, mtime: s.mtime, dims },
          })

          // Stale-tab guard helper: if the user switched away while a
          // probe / decode was running, drop the result silently.
          const stillActive = () => {
            const cur = active()
            return cur != null && cur.path === key.path
          }
          // Reflect freshly-discovered dims back into the metadata card
          // without dropping any other field. Keeps the card useful when
          // decode succeeds OR fails downstream.
          const pushDims = (probedDims: ImageDims) => {
            if (!stillActive()) return
            dims = probedDims
            setContent({
              kind: "media",
              media: { relPath: key.path, kind: mediaKind, size: s.size, mtime: s.mtime, dims },
            })
          }
          const pushDecoded = (probedDims: ImageDims, decoded: DecodedImage) => {
            if (!stillActive()) return
            setContent({
              kind: "media",
              media: {
                relPath: key.path,
                kind: mediaKind,
                size: s.size,
                mtime: s.mtime,
                dims: probedDims,
                decoded,
              },
            })
          }
          const pushAnimation = (probedDims: ImageDims, animation: DecodedImageSequence) => {
            if (!stillActive()) return
            setContent({
              kind: "media",
              media: {
                relPath: key.path,
                kind: mediaKind,
                size: s.size,
                mtime: s.mtime,
                dims: probedDims,
                animation,
              },
            })
          }

          const budget = computeImageBudget()
          if (mediaKind.kind === "image" && dims) {
            const target = computeTargetDims(dims.width, dims.height, budget.maxCols, budget.maxRows)
            // GIFs go through the multi-frame decoder. We probe timing
            // first to decide between animated and still rendering;
            // a 1-frame GIF (yes, it's a thing) falls through to the
            // static decodeImage path so MediaBody doesn't spin up a
            // pointless animation timer.
            if (mediaKind.format === "gif") {
              void probeFrameTiming(s.absPath).then(async (timing) => {
                if (timing && timing.frameCount > 1) {
                  const seq = await decodeAnimatedImage(
                    s.absPath,
                    target.cols,
                    target.pixelRows,
                    timing.frameCount,
                    timing.frameDelayMs,
                  )
                  if (seq) {
                    pushAnimation(dims as ImageDims, seq)
                    return
                  }
                }
                // Fallback: timing failed, or single frame, or decode
                // failed — show the still first frame.
                const still = await decodeImage(s.absPath, target.cols, target.pixelRows)
                if (still) pushDecoded(dims as ImageDims, still)
              })
            } else {
              void decodeImage(s.absPath, target.cols, target.pixelRows).then((decoded) => {
                if (decoded) pushDecoded(dims as ImageDims, decoded)
              })
            }
          } else if (mediaKind.kind === "video") {
            // Video: probe dims first (no cheap header parser like PNG),
            // then decode the first frame at the aspect-correct size.
            void probeMediaDims(s.absPath).then(async (probed) => {
              if (!probed || !stillActive()) return
              pushDims(probed)
              const target = computeTargetDims(probed.width, probed.height, budget.maxCols, budget.maxRows)
              const decoded = await decodeVideoFirstFrame(s.absPath, target.cols, target.pixelRows)
              if (decoded) pushDecoded(probed, decoded)
            })
          } else if (mediaKind.kind === "pdf") {
            // PDF: pdftoppm doesn't expose page size cheaply, so we render
            // straight to the full half-block budget and rely on
            // aspect-correct rasterization downstream of pdftoppm. The
            // resulting PNG's dims feed back from probeMediaDims after
            // decode for the metadata card.
            const target = computeTargetDims(
              // A4 portrait aspect (1:1.41) is the safe default — most
              // PDFs are close. `computeTargetDims` will downscale if the
              // budget can't fit.
              850,
              1100,
              budget.maxCols,
              budget.maxRows,
            )
            void decodePdfFirstPage(s.absPath, target.cols, target.pixelRows).then((decoded) => {
              if (!decoded || !stillActive()) return
              // We don't have authoritative page dims; report the render
              // dims so the user at least sees what was produced.
              pushDecoded({ width: target.cols, height: target.pixelRows }, decoded)
            })
          }
          return
        }

        if (key.mode === "diff") {
          const base = props.diffBase()
          if (!base) {
            setContent({
              kind: "error",
              message: "no diff base configured — press f to view the file instead",
            })
            return
          }
          const r = await readDiff(wt, base, key.path)
          if (!r.ok) {
            setContent({ kind: "error", message: summarizePreviewError(r.error) })
            return
          }
          setContent({ kind: "lines", lines: splitLines(r.text), mode: "diff" })
          return
        }
        const r = await readFile(wt, key.path)
        if (!r.ok) {
          setContent({ kind: "error", message: summarizePreviewError(r.error) })
          return
        }
        // SVG is text by definition — its kind is already known, so we
        // skip the NUL-byte sniff. For anything else the sniff is still
        // the final guard against surprise binaries (unknown extension,
        // missing extension, etc.).
        if (mediaKind.kind !== "svg" && looksBinary(r.text)) {
          setContent({
            kind: "error",
            message: "(binary file — preview not supported)",
          })
          return
        }
        // SVG (and any other XML-family text) goes through the XML
        // tokenizer for syntax-aware coloring. Diff mode keeps the
        // unified-diff rendering path because the green/red prefix
        // semantics are more useful there than tag/attr colors.
        if (mediaKind.kind === "svg" && key.mode === "file") {
          const tokens = tokenizeXml(r.text)
          setContent({ kind: "xml", rows: splitTokensByLine(tokens) })
          return
        }
        setContent({ kind: "lines", lines: splitLines(r.text), mode: "file" })
      },
    ),
  )

  // Whenever the active tab changes, restore its persisted scroll
  // position. The component owns the actual scrolling; the state just
  // remembers where each tab was.
  createEffect(
    on(
      () => active()?.path,
      () => {
        const cur = active()
        scroll?.scrollTo(cur?.scrollTop ?? 0)
      },
    ),
  )

  // Pane-local key bindings.
  usePreviewBindings({
    focused: focusedAccessor,
    externalTabControl: () => props.hideInternalTabs?.() ?? false,
    setMode: (mode) => setState((s) => setActiveMode(s, mode)),
    cycleTab: (delta) => setState((s) => moveActive(s, delta)),
    closeActive: () => {
      const cur = active()
      if (!cur) return
      // When the parent owns the tab strip (CenterTabStrip in app.tsx),
      // delegate close so the parent's tab list stays the source of
      // truth — otherwise ctrl+w clears Preview's internal mirror but
      // the parent's strip still shows the tab.
      if (props.hideInternalTabs?.() && props.onExternalClose) {
        props.onExternalClose(cur.path)
        return
      }
      setState((s) => closeTab(s, cur.path))
    },
    scrollBy: (delta) => {
      const cur = scroll
      if (!cur) return
      cur.scrollBy(delta)
      setState((s) => setActiveScroll(s, Math.max(0, (active()?.scrollTop ?? 0) + delta)))
    },
    scrollToTop: () => {
      scroll?.scrollTo(0)
      setState((s) => setActiveScroll(s, 0))
    },
    scrollToBottom: () => {
      // opentui's scrollbox doesn't expose a content-height accessor
      // on every renderer, but a very large scrollTo clamps internally.
      // 1e9 is well above any realistic file's line count.
      scroll?.scrollTo(1e9)
    },
    pageSize: () => PAGE_LINES,
  })

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Header active={active} />
      <Show when={!props.hideInternalTabs?.()}>
        <TabBar tabs={tabs} active={active} setState={setState} />
      </Show>
      <Body
        content={content}
        refSet={(r) => {
          scroll = r
        }}
      />
    </box>
  )
}

/* --------------------------------------------------------------------- */
/*  Header — shows active file path + mode badge                          */
/* --------------------------------------------------------------------- */

function Header(props: { active: Accessor<PreviewTab | undefined> }) {
  const { theme } = useTheme()
  // Read derived strings directly from memoized accessors — `<Show>` with
  // a function child is reactive but only over its truthy-transition, not
  // over per-field updates. We want the header label to refresh whenever
  // `mode` flips, not just when the active tab changes from undefined to
  // defined. Direct accessors keep the dependency graph trivial.
  const label = () => {
    const a = props.active()
    if (!a) return ""
    return `${a.path}`
  }
  const mode = () => props.active()?.mode ?? ""
  const hasActive = () => Boolean(props.active())
  return (
    <box flexDirection="row" justifyContent="space-between" paddingTop={1} paddingBottom={0} flexShrink={0}>
      <Show when={hasActive()} fallback={<text fg={theme.textMuted}>preview</text>}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
          {label()} <span style={{ fg: theme.textMuted }}>· {mode()}</span>
        </text>
      </Show>
      <text fg={theme.textMuted} wrapMode="none">
        f file · d diff · ctrl+w close · tab next
      </text>
    </box>
  )
}

/* --------------------------------------------------------------------- */
/*  Tab bar — one chip per open file                                      */
/* --------------------------------------------------------------------- */

function TabBar(props: {
  tabs: Accessor<readonly PreviewTab[]>
  active: Accessor<PreviewTab | undefined>
  setState: (updater: (s: PreviewState) => PreviewState) => void
}) {
  const { theme } = useTheme()
  return (
    <Show when={props.tabs().length > 0}>
      <box flexDirection="row" gap={1} flexShrink={0} paddingTop={0} paddingBottom={1}>
        <For each={props.tabs()}>
          {(tab) => {
            const isActive = () => props.active()?.path === tab.path
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={isActive() ? theme.primary : theme.backgroundElement}
                onMouseUp={() => {
                  // Click on the tab body activates it. Click on the
                  // `x` glyph fires its own handler below and stops
                  // propagation by closing first.
                  props.setState((s) => openTab(s, tab.path, tab.mode))
                }}
              >
                <text
                  fg={isActive() ? theme.selectedListItemText : theme.text}
                  attributes={isActive() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                >
                  {tabLabel(tab)}
                </text>
                <text
                  fg={isActive() ? theme.selectedListItemText : theme.textMuted}
                  onMouseUp={() => {
                    // Close the tab. The setState callback runs after
                    // the parent's onMouseUp; call it asynchronously
                    // via microtask so the click on the x doesn't
                    // first activate the tab via the parent handler.
                    queueMicrotask(() => props.setState((s) => closeTab(s, tab.path)))
                  }}
                >
                  x
                </text>
              </box>
            )
          }}
        </For>
      </box>
    </Show>
  )
}

/* --------------------------------------------------------------------- */
/*  Body — scrollable rendered output                                     */
/* --------------------------------------------------------------------- */

function Body(props: { content: Accessor<ContentState>; refSet: (r: ScrollBoxRenderable) => void }) {
  const { theme } = useTheme()

  // Solid `<Switch>` re-runs only when the discriminator changes — exactly
  // what we want here. The IIFE pattern would have captured `content()` at
  // first render and never re-evaluated, so swapping File ↔ Diff modes
  // wouldn't surface in the rendered subtree. Each branch reads `content()`
  // again to access the variant-specific fields reactively.
  const kind = createMemo(() => props.content().kind)

  return (
    <box flexGrow={1} minWidth={0}>
      <Switch>
        <Match when={kind() === "empty"}>
          <box paddingTop={1} paddingLeft={1}>
            <text fg={theme.textMuted}>(open a file from the tree — enter)</text>
          </box>
        </Match>
        <Match when={kind() === "loading"}>
          <box paddingTop={1} paddingLeft={1}>
            <text fg={theme.textMuted}>loading…</text>
          </box>
        </Match>
        <Match when={kind() === "error"}>
          <ErrorBody content={props.content} />
        </Match>
        <Match when={kind() === "lines"}>
          <LinesBody content={props.content} refSet={props.refSet} />
        </Match>
        <Match when={kind() === "media"}>
          <MediaBody content={props.content} />
        </Match>
        <Match when={kind() === "xml"}>
          <XmlBody content={props.content} refSet={props.refSet} />
        </Match>
      </Switch>
    </box>
  )
}

function ErrorBody(props: { content: Accessor<ContentState> }) {
  const { theme } = useTheme()
  const message = () => {
    const c = props.content()
    return c.kind === "error" ? c.message : ""
  }
  // Messages that already start with `(...)` are informational
  // hints (binary file, no diff base), not errors. Render them in
  // muted text so the error red is reserved for actual failures.
  const isHint = () => message().startsWith("(") || message().includes("press f")
  return (
    <box paddingTop={1} paddingLeft={1}>
      <text fg={isHint() ? theme.textMuted : theme.error} wrapMode="word">
        {isHint() ? message() : `error: ${message()}`}
      </text>
    </box>
  )
}

function LinesBody(props: { content: Accessor<ContentState>; refSet: (r: ScrollBoxRenderable) => void }) {
  const { theme } = useTheme()
  const linesData = createMemo(() => {
    const c = props.content()
    if (c.kind !== "lines") return { lines: [] as string[], mode: "file" as PreviewMode }
    return { lines: c.lines, mode: c.mode }
  })
  const lines = createMemo(() => linesData().lines)
  const mode = createMemo(() => linesData().mode)
  const isEmpty = createMemo(() => mode() === "diff" && lines().length === 0)

  return (
    <Show
      when={!isEmpty()}
      fallback={
        <box paddingTop={1} paddingLeft={1}>
          <text fg={theme.textMuted}>(no diff — file matches base, press f for content)</text>
        </box>
      }
    >
      <scrollbox ref={props.refSet} flexGrow={1} scrollbarOptions={{ visible: false }}>
        <For each={lines()}>
          {(line) => (
            <Show when={mode() === "diff"} fallback={<FileLine text={line} />}>
              <DiffLine text={line} />
            </Show>
          )}
        </For>
      </scrollbox>
    </Show>
  )
}

/**
 * Metadata card for binary media files (KOB-14). We never try to
 * render image pixels in the TUI — opentui has no built-in image
 * renderable on this version, and writing raw graphics escapes from
 * inside an opentui frame would race with its screen buffer. The
 * card tells the user what the file is, how big it is, when it last
 * changed, and (for images we can parse) its pixel dimensions — enough
 * to decide whether to open it externally.
 */
export function describeMediaKind(kind: MediaKind): string {
  switch (kind.kind) {
    case "image": {
      const labels: Readonly<Record<ImageFormat, string>> = {
        png: "PNG image",
        jpg: "JPEG image",
        gif: "GIF image",
        webp: "WEBP image",
      }
      return labels[kind.format]
    }
    case "video":
      return kind.label
    case "pdf":
      return "PDF document"
    case "binary":
      return kind.label
    case "svg":
      return "SVG image"
    case "text":
      return "text"
  }
}

/** Compact `YYYY-MM-DD HH:MM` formatter for the mtime line. */
export function formatMtime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function MediaBody(props: { content: Accessor<ContentState> }) {
  const { theme } = useTheme()
  const media = createMemo<MediaContent | null>(() => {
    const c = props.content()
    return c.kind === "media" ? c.media : null
  })
  return (
    <Show when={media()}>
      {(m) => {
        // `m` is a Solid accessor; we read it through createMemo so each
        // derived field re-tracks when the underlying MediaContent flips
        // (e.g. metadata-only snapshot → metadata+decoded snapshot after
        // ffmpeg returns). Reading `m()` once at the top of the function
        // would freeze the values on first paint and the half-block
        // image would never appear.
        const lines = createMemo<readonly (readonly [string, string])[]>(() => {
          const info = m()
          return [
            ["Type", describeMediaKind(info.kind)],
            ...(info.dims ? [["Dimensions", `${info.dims.width} × ${info.dims.height} px`] as const] : []),
            ["Size", formatBytes(info.size)],
            ["Modified", formatMtime(info.mtime)],
          ]
        })
        // VSCode-style UX: once the inline preview is up, the full
        // metadata table becomes redundant chrome. We collapse it to a
        // single compact "300×168 · PNG · 52.1 KiB" subtitle next to
        // the path. The expanded table only renders when the decode
        // hasn't (or can't) succeed — that's the case where the user
        // actually needs to see size / mtime to decide whether to open
        // externally.
        const previewReady = createMemo(() => {
          const info = m()
          return info.decoded != null || info.animation != null
        })
        const decodedSubtitle = createMemo(() => {
          const info = m()
          if (!previewReady()) return null
          const parts: string[] = []
          if (info.dims) parts.push(`${info.dims.width}×${info.dims.height}`)
          parts.push(describeMediaKind(info.kind))
          parts.push(formatBytes(info.size))
          if (info.animation) parts.push(`▶ ${info.animation.frames.length} frames`)
          return parts.join(" · ")
        })
        const hint = createMemo(() => {
          const info = m()
          const canPreview = info.kind.kind === "image" || info.kind.kind === "video" || info.kind.kind === "pdf"
          if (canPreview && !previewReady()) return "rendering preview…"
          return "(binary file — open externally to view)"
        })

        // Animation: when a GIF's frames are loaded, run a setInterval
        // that flips the active frame index. The interval is rebuilt
        // (and the old one torn down) whenever the animation reference
        // changes — switching tabs replaces the MediaContent snapshot
        // entirely, which resets the timer cleanly.
        const [frameIdx, setFrameIdx] = createSignal(0)
        createEffect(
          on(
            () => m().animation,
            (seq) => {
              setFrameIdx(0)
              if (!seq || seq.frames.length <= 1) return
              const timer = setInterval(() => {
                setFrameIdx((i) => (i + 1) % seq.frames.length)
              }, seq.frameDelayMs)
              onCleanup(() => clearInterval(timer))
            },
          ),
        )
        const currentDecoded = createMemo<DecodedImage | null>(() => {
          const info = m()
          if (info.animation) {
            const idx = frameIdx() % info.animation.frames.length
            return {
              cols: info.animation.cols,
              pixelRows: info.animation.pixelRows,
              rgb: info.animation.frames[idx],
            }
          }
          return info.decoded ?? null
        })
        return (
          <box paddingTop={1} paddingLeft={1} paddingRight={1} flexDirection="column">
            <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
              {m().relPath}
              <Show when={decodedSubtitle()}>{(sub) => <span style={{ fg: theme.textMuted }}> · {sub()}</span>}</Show>
            </text>
            <Show when={currentDecoded()}>
              {(decoded) => (
                <box paddingTop={1} flexDirection="column">
                  <HalfBlockImage decoded={decoded()} />
                </box>
              )}
            </Show>
            <Show when={!previewReady()}>
              <box paddingTop={1} flexDirection="column">
                <For each={lines()}>
                  {([label, value]) => (
                    <box flexDirection="row">
                      <text fg={theme.textMuted} wrapMode="none">
                        {label.padEnd(11, " ")}
                      </text>
                      <text fg={theme.text} wrapMode="none">
                        {value}
                      </text>
                    </box>
                  )}
                </For>
              </box>
              <box paddingTop={1}>
                <text fg={theme.textMuted} wrapMode="word">
                  {hint()}
                </text>
              </box>
            </Show>
          </box>
        )
      }}
    </Show>
  )
}

/**
 * Render a tokenized XML/SVG document as colored text rows. Each token
 * picks a theme color based on its kind; whitespace and unknown content
 * are rendered without styling so the visible diff vs. plain text is
 * limited to genuinely-meaningful tokens.
 *
 * Wrapped in a scrollbox to match `LinesBody` so the body scroll keymap
 * still works on highlighted documents.
 */
function XmlBody(props: { content: Accessor<ContentState>; refSet: (r: ScrollBoxRenderable) => void }) {
  const { theme } = useTheme()
  const rows = createMemo<XmlToken[][]>(() => {
    const c = props.content()
    return c.kind === "xml" ? c.rows : []
  })
  const colorFor = (kind: XmlToken["kind"]): RGBA => {
    switch (kind) {
      case "tag-delim":
        return theme.accent
      case "tag-name":
        return theme.info
      case "attr-name":
        return theme.warning
      case "attr-eq":
        return theme.textMuted
      case "attr-value":
        return theme.success
      case "comment":
      case "cdata":
      case "doctype":
        return theme.textMuted
      default:
        return theme.text
    }
  }
  return (
    <scrollbox ref={props.refSet} flexGrow={1} scrollbarOptions={{ visible: false }}>
      <For each={rows()}>
        {(row) => (
          <box paddingLeft={1} paddingRight={1}>
            <text wrapMode="none">
              <For each={row}>{(tok) => <span style={{ fg: colorFor(tok.kind) }}>{tok.text}</span>}</For>
              <Show when={row.length === 0}> </Show>
            </text>
          </box>
        )}
      </For>
    </scrollbox>
  )
}

/**
 * Render a {@link DecodedImage} as a stack of half-block character
 * rows. Each TUI row pairs two pixel rows: `fg` paints the upper half,
 * `bg` paints the lower half. We rebuild the cell grid once via
 * `createMemo` so re-renders that don't change the source bytes don't
 * walk the pixel array again.
 *
 * Adjacent cells with identical (fg, bg) pairs are merged into runs
 * keyed by `"rrggbb_rrggbb"`. For real photographic content this is
 * mostly a no-op (every cell differs); for screenshots / UI captures
 * with flat fills it cuts the span count substantially.
 */
function HalfBlockImage(props: { decoded: DecodedImage }) {
  type Run = { text: string; fg: RGBA; bg: RGBA }
  const rows = createMemo<Run[][]>(() => {
    const d = props.decoded
    const out: Run[][] = []
    for (let y = 0; y < d.pixelRows; y += 2) {
      const row: Run[] = []
      let cur: Run | null = null
      let curKey = ""
      for (let x = 0; x < d.cols; x++) {
        const topBase = (y * d.cols + x) * 3
        const botBase = ((y + 1) * d.cols + x) * 3
        const tr = d.rgb[topBase]
        const tg = d.rgb[topBase + 1]
        const tb = d.rgb[topBase + 2]
        const br = d.rgb[botBase]
        const bg = d.rgb[botBase + 1]
        const bb = d.rgb[botBase + 2]
        const key = `${tr},${tg},${tb}_${br},${bg},${bb}`
        if (cur && key === curKey) {
          cur.text += HALF_BLOCK_UPPER
          continue
        }
        cur = {
          text: HALF_BLOCK_UPPER,
          fg: RGBA.fromInts(tr, tg, tb, 255),
          bg: RGBA.fromInts(br, bg, bb, 255),
        }
        curKey = key
        row.push(cur)
      }
      out.push(row)
    }
    return out
  })
  return (
    <For each={rows()}>
      {(row) => (
        <text wrapMode="none">
          <For each={row}>{(run) => <span style={{ fg: run.fg, bg: run.bg }}>{run.text}</span>}</For>
        </text>
      )}
    </For>
  )
}
