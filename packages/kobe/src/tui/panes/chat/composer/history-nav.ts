/**
 * In-memory prompt-history cursor for one composer instance. The caller
 * supplies the current history list, current live draft, and imperative
 * buffer setter so this module owns only navigation state.
 */
export class PromptHistoryNavigator {
  private historyIndex: number | null = null
  private liveDraftSnapshot = ""

  constructor(
    private readonly entries: () => readonly string[],
    private readonly liveDraft: () => string,
    private readonly setBuffer: (text: string) => void,
  ) {}

  isActive(): boolean {
    return this.historyIndex !== null
  }

  reset(): void {
    this.historyIndex = null
    this.liveDraftSnapshot = ""
  }

  prev(): boolean {
    const list = this.entries()
    if (list.length === 0) return false
    if (this.historyIndex === null) {
      this.liveDraftSnapshot = this.liveDraft()
      this.historyIndex = list.length - 1
    } else if (this.historyIndex > 0) {
      this.historyIndex -= 1
    } else {
      return true
    }
    const recalled = list[this.historyIndex]
    if (recalled !== undefined) this.setBuffer(recalled)
    return true
  }

  next(): boolean {
    const list = this.entries()
    if (list.length === 0 || this.historyIndex === null) return false
    if (this.historyIndex < list.length - 1) {
      this.historyIndex += 1
      const recalled = list[this.historyIndex]
      if (recalled !== undefined) this.setBuffer(recalled)
    } else {
      this.historyIndex = null
      this.setBuffer(this.liveDraftSnapshot)
      this.liveDraftSnapshot = ""
    }
    return true
  }
}
