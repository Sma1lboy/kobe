/**
 * Render a `media` ContentState — metadata card plus, when available,
 * an inline true-pixel image painted through `PixelImageRenderable`.
 * Animated GIFs flip frames on a timer.
 *
 * UX flow (VSCode-style collapse):
 *   - When `decoded` / `animation` is set, the four-line Type/Size/Modified
 *     table collapses into a one-line muted subtitle on the path row.
 *   - When the file kind can't be previewed (PDF / video / audio /
 *     archive), or decode hasn't finished yet, the full table renders
 *     with an absolute-path row and a "Preview not supported for X.
 *     Open externally." hint.
 */

import { TextAttributes } from "@opentui/core"
import { type Accessor, For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useTheme } from "../../../context/theme"
import type { ContentState, MediaContent } from "../content-state"
import { describeMediaKind, formatBytes, formatMtime } from "../format"
import { type DecodedImage, PIXELS_PER_CELL } from "../image-render"
import "./PixelImageRenderable"

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
        const currentDecoded = createMemo<DecodedImage | null>(() => {
          const info = m()
          if (info.animation) {
            const idx = frameIdx() % info.animation.frames.length
            return {
              cols: info.animation.cols,
              pixelRows: info.animation.pixelRows,
              rgba: info.animation.frames[idx],
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
              {(decoded) => {
                // Pixel buffer dims are multiples of PIXELS_PER_CELL.{x,y};
                // converting back gives the cell footprint the renderable
                // needs to claim in the layout. We pin both width and height
                // so flex doesn't compress the image.
                const cellCols = createMemo(() => Math.ceil(decoded().cols / PIXELS_PER_CELL.x))
                const cellRows = createMemo(() => Math.ceil(decoded().pixelRows / PIXELS_PER_CELL.y))
                return (
                  <box paddingTop={1} flexDirection="column">
                    <pixel_image
                      pixels={decoded().rgba}
                      pixelCols={decoded().cols}
                      pixelRows={decoded().pixelRows}
                      width={cellCols()}
                      height={cellRows()}
                    />
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
