/**
 * Installs CJK-aware word boundaries (see `cjk-word.ts`) on EVERY opentui
 * text input by patching `TextareaRenderable.prototype` once at host boot.
 *
 * Why a prototype patch and not per-`<input>` refs: the word-jump methods
 * live on the shared base class of `<input>` AND `<textarea>`, and the
 * native (Zig) boundary functions they call are not configurable. One patch
 * point covers the quick-task composer, new-task dialog, rename dialog and
 * settings fields without touching each call site; a new input added
 * tomorrow gets correct Chinese word jumps for free.
 *
 * Scope: same-line jumps/deletes are reimplemented via `Intl.Segmenter`;
 * at a line edge (multi-line `<textarea>` only) the ORIGINAL native method
 * runs so cross-line movement keeps its old behavior. Selection bookkeeping
 * mirrors the originals: `updateSelectionForMovement` around moves,
 * `deleteSelection`/`clearSelection` around deletes — those members are
 * `protected`/absent in the d.ts, hence the single structural cast below.
 *
 * NOTE: imports @opentui — not importable under vitest. The pure boundary
 * math is in `cjk-word.ts`; only wiring lives here.
 */

import { TextareaRenderable } from "@opentui/core"
import { nextWordCol, prevWordCol } from "./cjk-word.ts"

/** Runtime shape of the renderable members the patch drives. */
interface WordEditTarget {
  plainText: string
  logicalCursor: { row: number; col: number }
  setCursor(row: number, col: number): void
  deleteRange(startLine: number, startCol: number, endLine: number, endCol: number): void
  hasSelection(): boolean
  deleteSelection(): boolean
  clearSelection(): boolean
  requestRender(): void
  updateSelectionForMovement(shiftPressed: boolean, isBeforeMovement: boolean): void
}

function lineAt(text: string, row: number): string {
  return text.split("\n")[row] ?? ""
}

let installed = false

/** Idempotent; called from the shared TUI host boot. */
export function installCjkWordBoundaries(): void {
  if (installed) return
  installed = true

  const proto = TextareaRenderable.prototype as unknown as WordEditTarget & {
    moveWordForward(options?: { select?: boolean }): boolean
    moveWordBackward(options?: { select?: boolean }): boolean
    deleteWordForward(): boolean
    deleteWordBackward(): boolean
  }
  const nativeMoveForward = proto.moveWordForward
  const nativeMoveBackward = proto.moveWordBackward
  const nativeDeleteForward = proto.deleteWordForward
  const nativeDeleteBackward = proto.deleteWordBackward

  proto.moveWordForward = function (this: WordEditTarget, options?: { select?: boolean }): boolean {
    const { row, col } = this.logicalCursor
    const line = lineAt(this.plainText, row)
    const target = nextWordCol(line, col)
    if (target <= col) return nativeMoveForward.call(this, options) // at line end → cross-line natively
    const select = options?.select ?? false
    this.updateSelectionForMovement(select, true)
    this.setCursor(row, target)
    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  proto.moveWordBackward = function (this: WordEditTarget, options?: { select?: boolean }): boolean {
    const { row, col } = this.logicalCursor
    if (col === 0) return nativeMoveBackward.call(this, options)
    const select = options?.select ?? false
    this.updateSelectionForMovement(select, true)
    this.setCursor(row, prevWordCol(lineAt(this.plainText, row), col))
    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  proto.deleteWordForward = function (this: WordEditTarget): boolean {
    if (this.hasSelection()) {
      this.deleteSelection()
      return true
    }
    const { row, col } = this.logicalCursor
    const target = nextWordCol(lineAt(this.plainText, row), col)
    if (target <= col) return nativeDeleteForward.call(this)
    this.deleteRange(row, col, row, target)
    this.clearSelection()
    this.requestRender()
    return true
  }

  proto.deleteWordBackward = function (this: WordEditTarget): boolean {
    if (this.hasSelection()) {
      this.deleteSelection()
      return true
    }
    const { row, col } = this.logicalCursor
    if (col === 0) return nativeDeleteBackward.call(this)
    const target = prevWordCol(lineAt(this.plainText, row), col)
    if (target < col) this.deleteRange(row, target, row, col)
    this.clearSelection()
    this.requestRender()
    return true
  }
}
