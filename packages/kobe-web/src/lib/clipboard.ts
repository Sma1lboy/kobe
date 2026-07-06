/**
 * Copy text to the clipboard, with a fallback for the rare non-secure context
 * where `navigator.clipboard` is missing. Resolves true on success, false if
 * both paths fail — callers use that to show a "Copied" vs error ack.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Clipboard API rejected (permissions / non-secure context) — fall back.
  }
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
