/**
 * Tree-sidebar search state — the `/` query, its keystroke capture, and the
 * enter/exit transitions.
 *
 * Split out of `SidebarTree.tsx` for the file-size cap. The mechanics are the
 * flat sidebar's (`Sidebar.tsx`) verbatim: a raw renderer keypress listener
 * rather than an opentui `<input>` (which misbehaved in the Solid original),
 * registered after the keymap dispatcher so chords that already
 * preventDefault'd never leak into the query.
 */

import type { KeyEvent } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { useCallback, useEffect, useState } from "react"
import { searchQueryKeystroke } from "../../../tui/panes/sidebar/view-core"
import { modalActive } from "../../lib/keymap"
import { useLatest } from "../../lib/use-latest"

export interface TreeSearch {
  readonly active: boolean
  readonly query: string
  readonly enter: () => void
  readonly exit: () => void
}

export function useTreeSearch(opts: {
  readonly focused: boolean
  readonly onActiveChange?: (active: boolean) => void
}): TreeSearch {
  const [active, setActive] = useState(false)
  const [query, setQuery] = useState("")
  const focusedRef = useLatest(opts.focused)
  const onActiveChange = opts.onActiveChange

  const enter = useCallback((): void => {
    setQuery("")
    setActive(true)
    onActiveChange?.(true)
  }, [onActiveChange])

  // Enter and esc both just close the query row; which row ends up selected
  // is the controller's business, not the search box's.
  const exit = useCallback((): void => {
    setActive(false)
    setQuery("")
    onActiveChange?.(false)
  }, [onActiveChange])

  const renderer = useRenderer()
  useEffect(() => {
    if (!active || !renderer) return
    const listener = (evt: KeyEvent): void => {
      // Raw listener — it bypasses dispatch, so it has to honor the dialog
      // overlay's modal barrier itself (same as the terminal catch-all).
      if (!focusedRef.current || modalActive()) return
      setQuery((q) => searchQueryKeystroke(q, evt) ?? q)
    }
    renderer.keyInput.on("keypress", listener)
    return () => {
      renderer.keyInput.off("keypress", listener)
    }
  }, [active, renderer])

  return { active, query, enter, exit }
}
