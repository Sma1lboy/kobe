/**
 * TokenizedText — render text that may contain `[Image #N]` placeholders (the
 * native CLI's echo for a pasted/dropped image) with each N rendered as the
 * real cached thumbnail, click-to-preview. The bytes come from the engine's
 * image cache via the sidecar (engineImageUrl); if the file isn't there yet (or
 * no session), the token falls back to a quiet chip. Shared by the input mirror
 * and the history user bubbles so both resolve images the same way.
 */

import { useEffect, useState } from "react"
import { engineImageUrl } from "../lib/terminal.ts"

const IMG_TOKEN = /\[Image #(\d+)\]/g

type Part = { text: string } | { img: number }

function split(text: string): Part[] {
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

/** Renders `text`; returns true from `hasImage` callers can't see, so the
 *  caller decides layout. Preview overlay is owned here. */
export function TokenizedText({
  text,
  sessionId,
  textClassName = "text-fg",
}: {
  text: string
  sessionId: string | null
  textClassName?: string
}) {
  const [preview, setPreview] = useState<string | null>(null)
  const parts = split(text)

  // Esc closes the preview (the backdrop click is the other way out).
  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setPreview(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [preview])

  return (
    <>
      {parts.map((part, i) =>
        "text" in part ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional, re-derived per frame
          <span key={i} className={textClassName}>
            {part.text}
          </span>
        ) : sessionId ? (
          <ImageThumb
            // biome-ignore lint/suspicious/noArrayIndexKey: positional, re-derived per frame
            key={i}
            src={engineImageUrl(sessionId, part.img)}
            n={part.img}
            onOpen={setPreview}
          />
        ) : (
          <Chip
            // biome-ignore lint/suspicious/noArrayIndexKey: positional, re-derived per frame
            key={i}
            n={part.img}
          />
        ),
      )}
      {preview && (
        // biome-ignore lint/a11y/noStaticElementInteractions: click-anywhere backdrop
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

/** A `[Image #N]` thumbnail; falls back to a chip if the cache file 404s. */
function ImageThumb({
  src,
  n,
  onOpen,
}: {
  src: string
  n: number
  onOpen: (src: string) => void
}) {
  const [broken, setBroken] = useState(false)
  if (broken) return <Chip n={n} />
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onOpen(src)
      }}
      className="mx-0.5 inline-block align-middle"
      title={`Image #${n} — click to preview`}
    >
      <img
        src={src}
        alt={`#${n}`}
        onError={() => setBroken(true)}
        className="h-9 w-auto rounded-md border border-line object-cover transition-colors hover:border-primary"
      />
    </button>
  )
}

function Chip({ n }: { n: number }) {
  return (
    <span className="mx-0.5 rounded bg-inset px-1.5 py-0.5 text-[11px] text-muted">
      Image #{n}
    </span>
  )
}
