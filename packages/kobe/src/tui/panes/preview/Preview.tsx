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
 * This file is intentionally the *shell* — every sub-piece lives in a
 * sibling module:
 *   - `body/Header.tsx`     — path + mode badge bar
 *   - `body/TabBar.tsx`     — internal tab strip
 *   - `body/Body.tsx`       — Switch dispatcher over ContentState
 *   - `body/MediaBody.tsx`  — metadata card + inline chafa grid
 *   - `body/XmlBody.tsx`, `body/LinesBody.tsx`, `body/ErrorBody.tsx`
 *   - `content-state.ts`    — ContentState + MediaContent types
 *   - `chafa-render.ts`     — chafa subprocess + ANSI parser → ChafaGrid
 *   - `gif-frames.ts`       — ffmpeg frame extraction + chafa-per-frame
 *   - `error-summary.ts`    — summarizePreviewError, looksBinary
 *   - `image-budget.ts`     — terminal-size-driven render budget
 *   - `format.ts`           — describeMediaKind / formatMtime / formatBytes
 *
 * Imperative API: parent passes an `onOpen(api)` callback. We invoke it
 * once at mount with `{ open(path), close(path) }`. The parent (Stream H
 * file tree, then the orchestrator) calls those to drive the pane.
 *
 * Why `createEffect` (not `createResource`) for fetches: the data
 * source is a synchronous `spawnSync` (see diff.ts) wrapped in
 * `Promise.resolve` for API symmetry. Effect + signal is the simplest
 * cycle: dependencies are `(activeTab, mode)`, output is a content
 * signal the renderer reads. `createResource`'s loading/error machinery
 * adds noise we don't need at this scale.
 */

import type { ScrollBoxRenderable } from "@opentui/core"
import { type Accessor, Show, createEffect, createMemo, createSignal, on, onMount } from "solid-js"
import { Body } from "./body/Body"
import { Header } from "./body/Header"
import { TabBar } from "./body/TabBar"
import { type ChafaGrid, renderImageAsSixel, renderImageWithChafa } from "./chafa-render"
import type { ContentState, SixelAnimationContent } from "./content-state"
import { isPathChanged, readDiff, readFile, readHeaderBytes, splitLines, statFile } from "./diff"
import { looksBinary, summarizePreviewError } from "./error-summary"
import { renderAnimatedGifAsSixel } from "./gif-frames"
import { computeImageBudget, sixelPixelsToCells } from "./image-budget"
import { usePreviewBindings } from "./keys"
import { type ImageDims, detectMediaKind, parseImageHeader } from "./media"
import { detectSixelSupport } from "./sixel-capability"
import {
  EMPTY_STATE,
  type PreviewState,
  type PreviewTab,
  activeTab,
  closeTab,
  moveActive,
  openTab,
  setActiveMode,
  setActiveScroll,
} from "./state"
import { splitTokensByLine, tokenizeXml } from "./xml-highlight"

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

export function Preview(props: PreviewProps) {
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
    // Diff auto-upgrade only makes sense for code-ish files where a
    // unified text diff carries information. Media types (image,
    // video, pdf, audio, archive) go through the metadata card in
    // either mode, and SVG is more useful as syntax-highlighted XML
    // than as a text diff of its source. Stay in file mode for these.
    const mediaKind = detectMediaKind(relPath)
    if (mediaKind.kind !== "text") return
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

  // Re-fetch content whenever the active tab path or mode changes. We
  // track `(path, mode)` explicitly so changing scroll or other tab
  // fields doesn't trigger a refetch.
  createEffect(
    on(
      () => {
        const cur = active()
        if (!cur) return null
        return { path: cur.path, mode: cur.mode }
      },
      (key) => loadContent(key),
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

  /**
   * Resolve a (path, mode) request into a {@link ContentState} and
   * push it through `setContent`. Routes by media kind:
   *
   *   - image / video / pdf / opaque binary  → metadata card via
   *     {@link loadMedia}, with images getting a deferred half-block
   *     decode that lands on a second `setContent`.
   *   - svg                                  → read file then route to
   *     the XML highlighter (file mode only); diff mode still uses the
   *     unified-diff path so green/red prefix semantics stay useful.
   *   - everything else                      → read file/diff and emit
   *     `kind: "lines"`. Unknown-extension binaries are caught by the
   *     NUL-byte sniff and surface a "preview not supported" hint.
   */
  async function loadContent(key: { path: string; mode: "file" | "diff" } | null): Promise<void> {
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

    // Known media types (images, GIF, video, PDF, audio, archives…)
    // never go through the text pipeline in either mode — KOB-14.
    const mediaKind = detectMediaKind(key.path)
    const canPreview =
      mediaKind.kind === "image" ||
      mediaKind.kind === "video" ||
      mediaKind.kind === "pdf" ||
      mediaKind.kind === "binary"
    if (canPreview) {
      await loadMedia(wt, key.path, mediaKind)
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
      setContent({ kind: "error", message: "(binary file — preview not supported)" })
      return
    }
    // SVG goes through the XML tokenizer for syntax-aware coloring in
    // file mode. Diff mode falls through to the unified-diff renderer
    // above (red/green prefix is more useful there).
    if (mediaKind.kind === "svg" && key.mode === "file") {
      const tokens = tokenizeXml(r.text)
      setContent({ kind: "xml", rows: splitTokensByLine(tokens) })
      return
    }
    setContent({ kind: "lines", lines: splitLines(r.text), mode: "file" })
  }

  /**
   * Populate the media card and, for image kinds, kick off a deferred
   * inline-render decode. Extracted from {@link loadContent} so the
   * effect body stays readable — the image branch alone is ~40 lines
   * of stale-tab-guarded promise plumbing.
   */
  async function loadMedia(wt: string, relPath: string, mediaKind: ReturnType<typeof detectMediaKind>): Promise<void> {
    const s = await statFile(wt, relPath)
    if (!s.ok) {
      setContent({ kind: "error", message: summarizePreviewError(s.error) })
      return
    }
    // Header-parsed image dims when we have a known image format.
    // Video / PDF stay in the metadata-only lane (per ticket); we
    // don't probe their dims because we never decode them inline.
    let dims: ImageDims | undefined
    if (mediaKind.kind === "image") {
      const h = await readHeaderBytes(wt, relPath, 32 * 1024)
      if (h.ok) {
        const parsed = parseImageHeader(h.buf, mediaKind.format)
        if (parsed) dims = parsed
      }
    }
    // Set the metadata card first so the user sees something
    // immediately while ffmpeg works in the background (image
    // path only).
    setContent({
      kind: "media",
      media: { relPath, absPath: s.absPath, kind: mediaKind, size: s.size, mtime: s.mtime, dims },
    })

    if (mediaKind.kind !== "image" || !dims) return

    // Stale-tab guard: if the user switched away while a decode was
    // running, drop the result silently.
    const stillActive = () => {
      const cur = active()
      return cur != null && cur.path === relPath
    }
    const pushGrid = (probedDims: ImageDims, grid: ChafaGrid) => {
      if (!stillActive()) return
      setContent({
        kind: "media",
        media: {
          relPath,
          absPath: s.absPath,
          kind: mediaKind,
          size: s.size,
          mtime: s.mtime,
          dims: probedDims,
          grid,
        },
      })
    }
    const pushSixel = (probedDims: ImageDims, sixel: Buffer, sixelCells: { cols: number; rows: number }) => {
      if (!stillActive()) return
      setContent({
        kind: "media",
        media: {
          relPath,
          absPath: s.absPath,
          kind: mediaKind,
          size: s.size,
          mtime: s.mtime,
          dims: probedDims,
          sixel,
          sixelCells,
        },
      })
    }
    const pushAnimation = (probedDims: ImageDims, animation: SixelAnimationContent) => {
      if (!stillActive()) return
      setContent({
        kind: "media",
        media: {
          relPath,
          absPath: s.absPath,
          kind: mediaKind,
          size: s.size,
          mtime: s.mtime,
          dims: probedDims,
          animation,
        },
      })
    }

    const { maxCols, maxRows } = computeImageBudget()
    // GIFs go through the multi-frame sixel path; a 1-frame GIF (yes,
    // it's a thing) falls through to the static sixel below so
    // MediaBody doesn't spin up a pointless animation timer.
    if (mediaKind.kind === "image" && mediaKind.format === "gif" && detectSixelSupport()) {
      const seq = await renderAnimatedGifAsSixel(s.absPath, maxCols, maxRows)
      if (seq && seq.frames.length > 1) {
        const sixelCells = sixelPixelsToCells(seq.pixelWidth, seq.pixelHeight, maxCols, maxRows)
        pushAnimation(dims as ImageDims, {
          frames: seq.frames,
          frameDelayMs: seq.frameDelayMs,
          sixelCells,
        })
        return
      }
    }
    // Sixel-capable terminals get a real-pixel render; everyone else
    // falls back to chafa's character grid. We try sixel first and
    // only run the symbols path if it didn't produce output.
    if (detectSixelSupport()) {
      const sixel = await renderImageAsSixel(s.absPath, maxCols, maxRows)
      if (sixel) {
        // chafa's sixel output uses absolute pixels; the WT-cell
        // footprint depends on the host terminal's cell pixel size.
        // We trust the raster attrs (Ph/Pv) chafa wrote and convert
        // using a typical-Cascadia-Mono cell size — the renderable
        // claims that many cells so its black background matches the
        // pixel image exactly, not the over-estimated cell budget.
        const sixelCells = sixelPixelsToCells(sixel.pixelWidth, sixel.pixelHeight, maxCols, maxRows)
        pushSixel(dims as ImageDims, sixel.bytes, sixelCells)
        return
      }
    }
    const grid = await renderImageWithChafa(s.absPath, maxCols, maxRows)
    if (grid) pushGrid(dims as ImageDims, grid)
  }

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
