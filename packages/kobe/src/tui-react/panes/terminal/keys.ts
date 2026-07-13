/**
 * Terminal pane key bindings — React hook layer, the
 * `tui/panes/terminal/keys.ts` counterpart (issue #16 React migration).
 *
 * Same passthrough contract as the Solid hook: when focused, every
 * keystroke the shell would expect (ctrl+c, ctrl+d, arrows, …) is
 * forwarded verbatim. Only `RESERVED_GLOBAL_CHORDS` and the
 * ctrl+pgup/pgdown scrollback chords stay kobe-owned — see
 * `keys-pure.ts` for the full rationale, unchanged and reused as-is.
 *
 * Pure/runtime split preserved: `keys-pure.ts` (constants + the
 * side-effect-free byte encoder) is imported straight from the Solid
 * cluster; this file owns only the React registration (`useBindings` +
 * the raw keypress/paste listeners on the renderer).
 */

import type { KeyEvent } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { useEffect, useMemo, useRef } from "react"
import {
  DEFAULT_PAGE_SIZE,
  PASSTHROUGH_CHORDS,
  TRAPPED_KEYS,
  keyEventToShellBytes,
} from "../../../tui/panes/terminal/keys-pure"
import { bindByIds } from "../../context/keybindings"
import { modalActive, useBindings } from "../../lib/keymap"
import { useLatest } from "../../lib/use-latest"

// Re-export pure helpers so callers can import everything from one path.
export { DEFAULT_PAGE_SIZE, TRAPPED_KEYS, keyEventToShellBytes }

/** Argument bag for {@link useTerminalBindings} — plain values, not Accessors (React re-renders on prop change). */
export type TerminalBindingsOpts = {
  /** Whether the terminal pane currently has focus. */
  focused: boolean
  /** Forward a byte sequence to the underlying PTY. */
  write: (data: string) => void
  /** Deliver pasted text (backend applies bracketed-paste wrapping). */
  paste: (text: string) => void
  /** Scroll the local scrollback view by N lines (negative = up). */
  scroll: (lines: number) => void
  /** How many lines `ctrl+pgup`/`ctrl+pgdown` move per press. Defaults to `DEFAULT_PAGE_SIZE`. */
  pageSize?: number
  /** Tear down the current PTY and spawn a fresh shell at the same worktree (F5, confirm-gated). */
  reset: () => void
}

/**
 * Register the terminal pane's pane-local bindings. `useBindings` re-reads
 * its config through a render-refreshed ref on every keypress, so this
 * hook can be called fresh every render (same pattern as `FileTree`'s
 * `useBindings` call) without going stale.
 */
export function useTerminalBindings(opts: TerminalBindingsOpts): void {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE
  const optsRef = useLatest(opts)
  const pageSizeRef = useLatest(pageSize)

  // Built once per mount: the pane re-renders per PTY output frame, and the
  // ~850-entry passthrough table is identical every time. Handlers read the
  // live opts through the render-refreshed ref, so nothing here goes stale.
  const bindings = useMemo(() => {
    const table: { key: string; cmd: (evt: KeyEvent) => void }[] = []
    // Scrollback exceptions FIRST so they take precedence over any
    // passthrough variants of `pageup`/`pagedown` registered later.
    table.push(
      ...bindByIds({
        "terminal.scroll-up": () => optsRef.current.scroll(-pageSizeRef.current),
        "terminal.scroll-down": () => optsRef.current.scroll(pageSizeRef.current),
        "terminal.reset": () => optsRef.current.reset(),
      }),
    )
    const forward = (evt: KeyEvent): void => {
      const bytes = keyEventToShellBytes(evt)
      if (bytes != null) optsRef.current.write(bytes)
    }
    for (const chord of PASSTHROUGH_CHORDS) table.push({ key: chord, cmd: forward })
    return table
  }, [])

  useBindings(() => ({
    enabled: optsRef.current.focused,
    bindings,
  }))

  // Catch-all input forwarder for IME/pinyin composition commits and any
  // input whose `name` isn't in `PASSTHROUGH_NAMES` — see the Solid
  // original for the full defaultPrevented rationale. Registered ONCE
  // (empty deps) and reads the latest `opts` through a render-refreshed
  // ref, so it doesn't re-subscribe to the renderer's emitter every render.
  const renderer = useRenderer()
  useEffect(() => {
    if (!renderer) return
    // `modalActive()`: pane focus does NOT change when a dialog opens, so
    // without it this forwarder eats the keystroke (preventDefault) before
    // the dialog's focused <input> can — typing into a rename dialog lands
    // in the PTY instead. The useBindings entries above are already cut off
    // by the modal barrier; raw listeners must gate themselves.
    const forwardUnhandled = (evt: KeyEvent) => {
      if (!optsRef.current.focused || evt.defaultPrevented || modalActive()) return
      const bytes = keyEventToShellBytes(evt)
      if (bytes == null) return
      optsRef.current.write(bytes)
      evt.preventDefault()
    }
    const forwardPaste = (evt: { bytes: Uint8Array; defaultPrevented: boolean; preventDefault(): void }) => {
      if (!optsRef.current.focused || evt.defaultPrevented || modalActive()) return
      const text = new TextDecoder().decode(evt.bytes)
      if (text.length === 0) return
      optsRef.current.paste(text)
      evt.preventDefault()
    }
    renderer.keyInput.on("keypress", forwardUnhandled)
    renderer.keyInput.on("paste", forwardPaste)
    return () => {
      renderer.keyInput.off("keypress", forwardUnhandled)
      renderer.keyInput.off("paste", forwardPaste)
    }
  }, [renderer])
}
