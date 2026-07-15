/**
 * Isolated, failure-tolerant listener fan-out for one terminal emulator.
 *
 * `XtermTaskPty` owns when a terminal becomes observable; this small helper
 * owns only safe Set bookkeeping and notification. Keeping that policy out of
 * the emulator makes lifecycle teardown less coupled to VT/snapshot code.
 */

import type { CursorPos, DataListener, TerminalRow } from "./pty-types"

type TitleListener = (title: string) => void
type ExitListener = () => void

export class PtyListeners {
  private readonly data = new Set<DataListener>()
  private readonly exits = new Set<ExitListener>()
  private readonly titles = new Set<TitleListener>()

  get dataCount(): number {
    return this.data.size
  }

  addData(listener: DataListener): () => void {
    this.data.add(listener)
    return () => this.data.delete(listener)
  }

  addExit(listener: ExitListener): () => void {
    this.exits.add(listener)
    return () => this.exits.delete(listener)
  }

  addTitle(listener: TitleListener): () => void {
    this.titles.add(listener)
    return () => this.titles.delete(listener)
  }

  publishData(snapshot: readonly TerminalRow[], cursor: CursorPos | null): void {
    for (const listener of this.data) {
      try {
        listener(snapshot, cursor)
      } catch {
        /* one listener must not break the others */
      }
    }
  }

  publishTitle(title: string): void {
    for (const listener of this.titles) {
      try {
        listener(title)
      } catch {
        /* one listener must not break the others */
      }
    }
  }

  /** Remove and return exit listeners for one final, isolated notification. */
  drainExits(): ExitListener[] {
    const listeners = [...this.exits]
    this.exits.clear()
    return listeners
  }

  clearData(): void {
    this.data.clear()
  }

  clearAll(): void {
    this.data.clear()
    this.exits.clear()
    this.titles.clear()
  }
}
