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
