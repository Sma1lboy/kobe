/**
 * CopyButton — the one clipboard affordance for transcript content. Copies
 * `text` (or a lazy getter for content assembled at click time) and flashes
 * a ✓ so the click reads as done. Standalone on purpose: every surface that
 * wants copy (user bubbles, assistant runs, code, composer) mounts THIS and
 * gets tuned in one place.
 */

import { Check, Copy } from "lucide-react"
import { useEffect, useRef, useState } from "react"

export function CopyButton({
  text,
  label = "Copy",
  className = "",
}: {
  /** Content to copy — a string, or a getter resolved at click time. */
  text: string | (() => string)
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    },
    [],
  )

  const copy = (): void => {
    const value = typeof text === "function" ? text() : text
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={label}
      aria-label={label}
      className={`flex h-5 w-5 items-center justify-center rounded text-subtle transition-colors hover:bg-inset hover:text-fg ${className}`}
    >
      {copied ? (
        <Check size={12} strokeWidth={2} className="text-kobe-green" />
      ) : (
        <Copy size={12} strokeWidth={1.6} />
      )}
    </button>
  )
}
