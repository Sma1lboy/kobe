/**
 * Capture images entering the compose (paste OR drag-drop) so the input mirror
 * can show `[Image #N]` as the actual N-th image (with click-to-preview). The
 * native CLI ingests the image itself and echoes `[Image #N]`; we ONLY observe
 * the same browser paste/drop event (capture phase, no preventDefault) to grab
 * the bytes for the render — delivery to the engine is untouched.
 *
 * This covers the LIVE compose only. Images in sent history live in the engine
 * transcript (base64 blocks); rendering those is a separate, engine-owned-
 * history job — see the GUI-chat handoff.
 *
 * ponytail: order-based mapping, reset when the compose line empties (submit).
 * Editing out a middle image desyncs numbering until the next send — fine for
 * the paste-then-send path, revisit if inline image editing matters.
 */

import { useEffect, useRef, useState } from "react"

export function usePastedImages(promptText: string): string[] {
  const [images, setImages] = useState<string[]>([])
  const prev = useRef("")

  useEffect(() => {
    const capture = (file: File): void => {
      if (!file.type.startsWith("image/")) return
      const reader = new FileReader()
      reader.onload = () =>
        setImages((cur) => [...cur, reader.result as string])
      reader.readAsDataURL(file)
    }
    const onPaste = (e: ClipboardEvent): void => {
      for (const it of e.clipboardData?.items ?? []) {
        if (it.kind === "file") {
          const f = it.getAsFile()
          if (f) capture(f)
        }
      }
    }
    // Drag-and-drop is the OTHER way an image enters the compose (the native
    // CLI's own suggested path); observe it too so those `[Image #N]` render as
    // thumbnails, not just pasted ones. Passive (no preventDefault) — delivery
    // to the engine is whatever already handled the drop.
    const onDrop = (e: DragEvent): void => {
      for (const f of e.dataTransfer?.files ?? []) capture(f)
    }
    window.addEventListener("paste", onPaste, true)
    window.addEventListener("drop", onDrop, true)
    return () => {
      window.removeEventListener("paste", onPaste, true)
      window.removeEventListener("drop", onDrop, true)
    }
  }, [])

  // Claude clears the composed `[Image #N]` list on submit; mirror that by
  // dropping our captures when the input line goes non-empty → empty.
  useEffect(() => {
    if (prev.current !== "" && promptText === "") setImages([])
    prev.current = promptText
  }, [promptText])

  return images
}
