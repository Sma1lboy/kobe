/**
 * InputMirror — the floating input row. It's NOT a textarea: it mirrors the
 * engine's native input line (`promptText`) with a blinking caret, and every
 * keystroke drives the hidden real CLI (a click anywhere focuses it). Pasted
 * images echo from the CLI as `[Image #N]` tokens; we render each as the actual
 * thumbnail (usePastedImages captured the bytes), clickable to a full preview.
 */

import { CornerDownLeft } from "lucide-react"
import { useState } from "react"

const IMG_TOKEN = /\[Image #(\d+)\]/g

type Part = { text: string } | { img: number }

/** Split `foo [Image #1] bar` into text runs and image refs (1-based N). */
function splitImageTokens(text: string): Part[] {
  const parts: Part[] = []
  let last = 0
  for (const m of text.matchAll(IMG_TOKEN)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) })
    parts.push({ img: Number(m[1]) })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts
}

const caret = (
  <span className="inline-block h-[1.05em] w-[2px] animate-pulse bg-primary align-text-bottom" />
)

export function InputMirror({
  promptText,
  images,
}: {
  promptText: string
  images: string[]
}) {
  const [preview, setPreview] = useState<string | null>(null)
  const parts = splitImageTokens(promptText)

  return (
    <>
      <div className="flex items-center gap-3 rounded-2xl border border-line bg-bg px-4 py-3 shadow-lg shadow-black/25">
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed">
          {promptText ? (
            <>
              {parts.map((part, i) =>
                "text" in part ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional, re-derived per frame
                  <span key={i} className="text-fg">
                    {part.text}
                  </span>
                ) : images[part.img - 1] ? (
                  <button
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional, re-derived per frame
                    key={i}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setPreview(images[part.img - 1])
                    }}
                    className="mx-0.5 inline-block align-middle"
                    title={`Image #${part.img} — click to preview`}
                  >
                    <img
                      src={images[part.img - 1]}
                      alt={`Pasted #${part.img}`}
                      className="h-9 w-auto rounded-md border border-line object-cover transition-colors hover:border-primary"
                    />
                  </button>
                ) : (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional, re-derived per frame
                    key={i}
                    className="mx-0.5 rounded bg-inset px-1.5 py-0.5 text-[11px] text-muted"
                  >
                    Image #{part.img}
                  </span>
                ),
              )}
              {caret}
            </>
          ) : (
            <>
              {caret}
              <span className="text-subtle"> Message the agent…</span>
            </>
          )}
        </span>
        <CornerDownLeft
          size={14}
          strokeWidth={2}
          className="shrink-0 text-subtle"
        />
      </div>
      {preview && (
        // biome-ignore lint/a11y/noStaticElementInteractions: click-anywhere-to-close backdrop
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-8"
          onMouseDown={(e) => {
            e.stopPropagation()
            setPreview(null)
          }}
        >
          <img
            src={preview}
            alt="Preview"
            className="max-h-full max-w-full rounded-lg border border-line shadow-2xl"
          />
        </div>
      )}
    </>
  )
}
