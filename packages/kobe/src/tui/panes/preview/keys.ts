/**
 * Pane-local key bindings for the preview pane.
 *
 * Mirrors `src/tui/panes/sidebar/keys.ts` — a Solid hook that registers
 * with the project's `useBindings` keymap layer (`src/tui/lib/keymap.tsx`).
 * Bindings only fire while `focused()` is true; when the pane is not
 * focused, the chat composer's input or the sidebar's j/k swallow the
 * keys instead.
 *
 * Bindings (matches the brief):
 *   - `f`           → switch active tab to File mode
 *   - `d`           → switch active tab to Diff mode
 *   - `tab`         → activate next tab
 *   - `shift+tab`   → activate previous tab
 *   - `ctrl+w`      → close active tab
 *   - `j`/`down`    → scroll body by 1 line
 *   - `k`/`up`      → scroll body by -1 line
 *   - `pagedown`    → scroll body by viewport height
 *   - `pageup`      → scroll body by -viewport height
 *   - `g g` (chord) → jump to top
 *   - `G`           → jump to bottom (shift+g, like vim)
 *
 * The `g g` chord uses the same approach as the sidebar: `shift+g` arrives
 * as `name="g", shift=true` from opentui (see keymap.tsx note about
 * single-letter shift handling), so we discriminate inside the handler
 * rather than registering a separate `shift+g` key.
 *
 * No reducer state lives here — the controller (state mutations) is in
 * `state.ts`, scroll commands are forwarded straight to the component's
 * scrollbox ref. The only stateful thing the hook owns is the `g g`
 * chord timer.
 */

import type { Accessor } from "solid-js"
import { useBindings } from "../../lib/keymap"
import { GG_CHORD_TIMEOUT_MS } from "../sidebar/controller"

export type PreviewBindingsOpts = {
  focused: Accessor<boolean>
  /** Set the active tab's mode. */
  setMode: (mode: "file" | "diff") => void
  /** Activate the tab at +1 / -1 from current. */
  cycleTab: (delta: number) => void
  /** Close the currently active tab. */
  closeActive: () => void
  /** Scroll the active body by `delta` lines (positive = down). */
  scrollBy: (delta: number) => void
  /** Jump scroll to absolute top (0). */
  scrollToTop: () => void
  /** Jump scroll to the very bottom. */
  scrollToBottom: () => void
  /**
   * Optional viewport height accessor for pgup/pgdn. Defaults to 10
   * lines if not provided — matches dialog-diff's fallback.
   */
  pageSize?: Accessor<number>
  /**
   * Optional clock injection for the `g g` chord; tests pass a fake to
   * deterministically expire without `setTimeout`. Mirrors the sidebar
   * controller's pattern.
   */
  scheduleTimeout?: (cb: () => void, ms: number) => () => void
  /**
   * When true, the parent owns tab UX (open/close/cycle) — Preview's own
   * tab/shift+tab/ctrl+w handlers are suppressed so the parent's bindings
   * can claim those keys. Mode (`f`/`d`) and scroll keys still fire.
   * Defaults to false (Preview owns its tabs).
   */
  externalTabControl?: Accessor<boolean>
}

/** Re-export the chord timeout so tests + UI consumers share one constant. */
export { GG_CHORD_TIMEOUT_MS }

/**
 * Register the preview pane's bindings. Bindings unmount with the
 * calling component (the keymap layer's `onCleanup` fires).
 *
 * The chord state lives in this closure rather than in a Solid signal:
 * keypresses always run synchronously inside the keymap handler, and
 * the chord is a transient micro-state with no UI projection.
 */
export function usePreviewBindings(opts: PreviewBindingsOpts): void {
  let pendingG = false
  let cancelChord: (() => void) | null = null

  const schedule =
    opts.scheduleTimeout ??
    ((cb, ms) => {
      const id = setTimeout(cb, ms)
      return () => clearTimeout(id)
    })

  function disarmChord(): void {
    pendingG = false
    cancelChord?.()
    cancelChord = null
  }

  function pressG(): void {
    if (pendingG) {
      // Second `g` within the window — complete the chord.
      disarmChord()
      opts.scrollToTop()
      return
    }
    pendingG = true
    cancelChord = schedule(() => {
      pendingG = false
      cancelChord = null
    }, GG_CHORD_TIMEOUT_MS)
  }

  function pressShiftG(): void {
    disarmChord()
    opts.scrollToBottom()
  }

  function page(direction: 1 | -1): void {
    disarmChord()
    const size = opts.pageSize ? opts.pageSize() : 10
    opts.scrollBy(direction * Math.max(1, size))
  }

  useBindings(() => {
    const ext = opts.externalTabControl?.() ?? false
    // When the parent owns the tab strip we still keep ctrl+w wired so
    // the user can close from inside the focused preview body — it just
    // delegates upward via `closeActive` (the component routes external
    // closes through `onExternalClose`). Tab/shift+tab cycling is the
    // parent's job in external mode and stays suppressed there.
    const tabBindings = ext
      ? [
          {
            key: "ctrl+w",
            cmd: () => {
              disarmChord()
              opts.closeActive()
            },
          },
        ]
      : [
          {
            key: "tab",
            cmd: () => {
              disarmChord()
              opts.cycleTab(1)
            },
          },
          {
            key: "shift+tab",
            cmd: () => {
              disarmChord()
              opts.cycleTab(-1)
            },
          },
          {
            key: "ctrl+w",
            cmd: () => {
              disarmChord()
              opts.closeActive()
            },
          },
        ]
    return {
      enabled: opts.focused(),
      bindings: [
        {
          key: "f",
          cmd: () => {
            disarmChord()
            opts.setMode("file")
          },
        },
        {
          key: "d",
          cmd: () => {
            disarmChord()
            opts.setMode("diff")
          },
        },
        ...tabBindings,
        {
          key: "j",
          cmd: () => {
            disarmChord()
            opts.scrollBy(1)
          },
        },
        {
          key: "down",
          cmd: () => {
            disarmChord()
            opts.scrollBy(1)
          },
        },
        {
          key: "k",
          cmd: () => {
            disarmChord()
            opts.scrollBy(-1)
          },
        },
        {
          key: "up",
          cmd: () => {
            disarmChord()
            opts.scrollBy(-1)
          },
        },
        { key: "pagedown", cmd: () => page(1) },
        { key: "pageup", cmd: () => page(-1) },
        {
          // Single binding handles both `g` (arm chord) and `G` (jump to
          // bottom). See file header for why shift+g comes through as
          // `name="g", shift=true`.
          key: "g",
          cmd: (event) => {
            if (event.shift) pressShiftG()
            else pressG()
          },
        },
      ],
    }
  })
}
