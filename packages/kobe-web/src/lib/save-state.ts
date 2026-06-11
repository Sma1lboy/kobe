/**
 * Autosave status for the notes panel + its human label. Shared out so the
 * label mapping is unit-testable away from the component (idle shows nothing —
 * the chip is hidden until the first save attempt).
 */

export type SaveState = "idle" | "saving" | "saved" | "error"

export function saveStatusLabel(state: SaveState): string {
  switch (state) {
    case "saving":
      return "saving…"
    case "saved":
      return "saved"
    case "error":
      return "save failed"
    default:
      return ""
  }
}
