/**
 * Render a `media` ContentState — metadata card plus, when available,
 * an inline image rendered via chafa into a colored character grid.
 * Animated GIFs flip frames on a timer.
 *
 * UX flow (VSCode-style collapse):
 *   - When `grid` / `animation` is set, the four-line Type/Size/Modified
 *     table collapses into a one-line muted subtitle on the path row.
 *   - When the file kind can't be previewed (PDF / video / audio /
 *     archive), or chafa hasn't finished yet, the full table renders
 *     with an absolute-path row and a "Preview not supported for X.
 *     Open externally." hint.
 */

import { RGBA, TextAttributes } from "@opentui/core"
import { type Accessor, For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useTheme } from "../../../context/theme"
import type { ChafaCell, ChafaGrid, ChafaRGB } from "../chafa-render"
import type { ContentState, MediaContent } from "../content-state"
import { describeMediaKind, formatBytes, formatMtime } from "../format"
import "./SixelImageRenderable"

export function MediaBody(props: { content: Accessor<ContentState> }) {
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
        // (e.g. metadata-only snapshot → metadata+grid snapshot after
        // chafa returns). Reading `m()` once at the top of the function
        // would freeze the values on first paint.
        const lines = createMemo<readonly (readonly [string, string])[]>(() => {
          const info = m()
          return [
            ["Type", describeMediaKind(info.kind)],
            ...(info.dims ? [["Dimensions", `${info.dims.width} × ${info.dims.height} px`] as const] : []),
            ["Size", formatBytes(info.size)],
            ["Modified", formatMtime(info.mtime)],
          ]
        })
        const previewReady = createMemo(() => {
          const info = m()
          return info.grid != null || info.animation != null || info.sixel != null
        })
        const gridSubtitle = createMemo(() => {
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
          if (info.kind.kind === "image" && !previewReady()) return "rendering preview…"
          return `Preview not supported for ${describeMediaKind(info.kind)}. Open externally.`
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
        const currentGrid = createMemo<ChafaGrid | null>(() => {
          const info = m()
          if (info.animation) {
            const idx = frameIdx() % info.animation.frames.length
            return info.animation.frames[idx]
          }
          return info.grid ?? null
        })
        return (
          <box paddingTop={1} paddingLeft={1} paddingRight={1} flexDirection="column">
            <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
              {m().relPath}
              <Show when={gridSubtitle()}>{(sub) => <span style={{ fg: theme.textMuted }}> · {sub()}</span>}</Show>
            </text>
            <Show
              when={m().sixel && m().sixelCells}
              fallback={<Show when={currentGrid()}>{(grid) => <ChafaGridView grid={grid()} />}</Show>}
            >
              {(_anchor) => {
                const sixel = createMemo(() => m().sixel as Buffer)
                const cells = createMemo(() => m().sixelCells as { cols: number; rows: number })
                return (
                  <box paddingTop={1} flexDirection="column" alignItems="center">
                    <sixel_image sixel={sixel()} width={cells().cols} height={cells().rows} />
                  </box>
                )
              }}
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
                {/*
                  Absolute path on its own row so the user can mouse-
                  select + copy it into an external viewer. The ticket
                  asks for "a copy-path hint" — in a TUI without a
                  clipboard primitive, exposing the full path verbatim
                  is the closest equivalent.
                */}
                <box flexDirection="row">
                  <text fg={theme.textMuted} wrapMode="none">
                    {"Path".padEnd(11, " ")}
                  </text>
                  <text fg={theme.text} wrapMode="none">
                    {m().absPath}
                  </text>
                </box>
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
 * Render one chafa-produced character grid. Adjacent cells sharing the
 * same (fg, bg) pair are coalesced into a single `<span>` so we don't
 * pay a JSX node per cell on flat-color regions.
 */
function ChafaGridView(props: { grid: ChafaGrid }) {
  type Run = { text: string; fg: RGBA; bg: RGBA }
  const rows = createMemo<Run[][]>(() => {
    const g = props.grid
    const out: Run[][] = []
    for (const row of g.cells) {
      const merged: Run[] = []
      let cur: Run | null = null
      let curKey = ""
      for (const cell of row) {
        const key = keyOf(cell)
        if (cur && key === curKey) {
          cur.text += cell.char
          continue
        }
        cur = {
          text: cell.char,
          fg: rgbaOf(cell.fg),
          bg: rgbaOf(cell.bg),
        }
        curKey = key
        merged.push(cur)
      }
      out.push(merged)
    }
    return out
  })
  return (
    <box paddingTop={1} flexDirection="column">
      <For each={rows()}>
        {(row) => (
          <text wrapMode="none">
            <For each={row}>{(run) => <span style={{ fg: run.fg, bg: run.bg }}>{run.text}</span>}</For>
          </text>
        )}
      </For>
    </box>
  )
}

function keyOf(cell: ChafaCell): string {
  return `${cell.fg.r},${cell.fg.g},${cell.fg.b}_${cell.bg.r},${cell.bg.g},${cell.bg.b}`
}

function rgbaOf(c: ChafaRGB): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, 255)
}
