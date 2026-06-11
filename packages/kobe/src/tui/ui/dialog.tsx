/**
 * Dialog stack.
 *
 * Adapted from `refs/opencode/packages/opencode/src/cli/cmd/tui/ui/dialog.tsx`.
 * The shape of the public API (`useDialog`, `replace`, `clear`, `setSize`,
 * `stack`, `size`) is preserved 1:1 so lifted dialogs (DialogConfirm,
 * DialogAlert, DialogDiff) work without modification.
 *
 * Differences from opencode:
 *   - escape/ctrl-c handling uses our local `useBindings` (no
 *     `@opentui/keymap`). Selection-aware behavior is preserved: pressing
 *     escape while text is selected clears the selection rather than the
 *     dialog stack.
 *   - We dropped the right-click "copy on select" plumbing tied to
 *     `OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT` and `useToast`. kobe
 *     doesn't have a toast system yet; can be added in a later stream.
 *   - `refocus` still tracks the renderable that held focus when the dialog
 *     opened so it gets focus back on close.
 */

import { RGBA, type Renderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { type JSX, type ParentProps, Show, batch, createContext, useContext } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../context/theme"
import { useBindings } from "../lib/keymap"

export type DialogSize = "small" | "medium" | "large" | "xlarge"

const DIALOG_BACKDROP = RGBA.fromInts(0, 0, 0, 128)
const TRANSPARENT_DIALOG_BACKDROP = RGBA.fromInts(0, 0, 0, 64)

export function Dialog(
  props: ParentProps<{
    size?: DialogSize
    onClose: () => void
  }>,
) {
  const dimensions = useTerminalDimensions()
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const renderer = useRenderer()

  let dismiss = false
  // Default-medium = 80 cols (was 60). At 60 the F1 help dialog and
  // settings dialogs felt cramped on wide terminals — descriptions
  // wrapped early and the right-side hint columns ran out of room.
  // 80 leaves comfortable headroom on a typical 100+-col terminal
  // while still capping at `dimensions().width - 2` (see maxWidth
  // below) for narrow PTY sizes. large + xlarge get proportional
  // bumps so the relative scale stays the same.
  //
  // `small` (50 cols) is for tight yes/no prompts — DialogConfirm,
  // delete confirms, etc. Otherwise the medium 80-col card looks
  // grossly oversized for two words and a button row. Callers opt
  // in via `dialog.setSize("small")` (see DialogConfirm.show).
  const width = () => {
    if (props.size === "xlarge") return 140
    if (props.size === "large") return 110
    if (props.size === "small") return 50
    return 80
  }

  // Vertical headroom around the card so it never lands flush against
  // the terminal's top/bottom edge — leaves room for the host shell's
  // status line, tmux pane labels, etc.
  const VERTICAL_MARGIN = 2
  const maxCardHeight = () => Math.max(8, dimensions().height - VERTICAL_MARGIN * 2)

  return (
    <box
      onMouseDown={() => {
        dismiss = !!renderer?.getSelection()
      }}
      onMouseUp={() => {
        if (dismiss) {
          dismiss = false
          return
        }
        props.onClose?.()
      }}
      width={dimensions().width}
      height={dimensions().height}
      alignItems="center"
      // Vertically center the card. The previous design used
      // `paddingTop = viewport/4`, which pushed tall cards (the
      // F1 keybinding help, settings) off the bottom of the terminal.
      // `justifyContent="center"` lets short cards float at center
      // and tall cards sit at top with their max-height clipped to
      // `maxCardHeight()` (see below) so they never overflow.
      justifyContent="center"
      position="absolute"
      zIndex={3000}
      left={0}
      top={0}
      backgroundColor={themeCtx.transparentBackground ? TRANSPARENT_DIALOG_BACKDROP : DIALOG_BACKDROP}
    >
      <box
        onMouseUp={(e: { stopPropagation(): void }) => {
          dismiss = false
          e.stopPropagation()
        }}
        width={width()}
        maxWidth={dimensions().width - 2}
        maxHeight={maxCardHeight()}
        flexShrink={1}
        // `flexGrow=0` is the default but I'm being explicit because
        // opentui's centering container (alignItems / justifyContent
        // = center on the overlay) can interact oddly with shrinkable
        // children — without it the card occasionally stretched to
        // fill the viewport's centered band. Content-sized + maxHeight
        // is the contract: short cards float as a tight block, tall
        // cards hit the cap and clip (children that need scrolling —
        // F1 help, settings — wrap their own scrollbox).
        flexGrow={0}
        // The card is ALWAYS opaque — even in transparent mode (where
        // only the backdrop lightens). A translucent card lets pane
        // content bleed through the dialog text and becomes unreadable.
        backgroundColor={theme.backgroundDialog}
        paddingTop={1}
      >
        {props.children}
      </box>
    </box>
  )
}

function init() {
  const [store, setStore] = createStore<{
    stack: { element: () => JSX.Element; onClose?: () => void }[]
    size: DialogSize
  }>({
    stack: [],
    size: "medium",
  })

  const renderer = useRenderer()
  let focus: Renderable | null = null

  function refocus() {
    setTimeout(() => {
      if (!focus) return
      if (focus.isDestroyed) return
      function find(item: Renderable): boolean {
        for (const child of item.getChildren()) {
          if (child === focus) return true
          if (find(child)) return true
        }
        return false
      }
      const root = renderer?.root
      if (!root) return
      if (!find(root)) return
      focus.focus()
    }, 1)
  }

  useBindings(() => ({
    enabled: store.stack.length > 0 && !renderer?.getSelection()?.getSelectedText(),
    bindings: [
      {
        key: "escape",
        cmd: () => {
          if (renderer?.getSelection()) renderer.clearSelection()
          const current = store.stack.at(-1)
          current?.onClose?.()
          setStore("stack", store.stack.slice(0, -1))
          refocus()
        },
      },
      {
        key: "ctrl+c",
        cmd: () => {
          if (renderer?.getSelection()) renderer.clearSelection()
          const current = store.stack.at(-1)
          current?.onClose?.()
          setStore("stack", store.stack.slice(0, -1))
          refocus()
        },
      },
    ],
  }))

  return {
    clear() {
      for (const item of store.stack) item.onClose?.()
      batch(() => {
        setStore("size", "medium")
        setStore("stack", [])
      })
      refocus()
    },
    /**
     * Replace the current dialog (if any) with a new one. The dialog body is
     * passed as a thunk (`() => <Dialog ... />`) so that the JSX is created
     * **inside the Solid render tree** when the provider renders the new
     * stack — not at the call site, which is usually a key handler outside
     * any Solid owner. Calling `useContext` / `useDialog` from a thunk
     * evaluated inside Solid's reconciler works; calling it from a keypress
     * handler does not.
     */
    replace(thunk: () => JSX.Element, onClose?: () => void) {
      if (store.stack.length === 0) {
        focus = renderer?.currentFocusedRenderable ?? null
        focus?.blur()
      }
      for (const item of store.stack) item.onClose?.()
      setStore("size", "medium")
      setStore("stack", [{ element: thunk, onClose }])
    },
    push(thunk: () => JSX.Element, onClose?: () => void) {
      if (store.stack.length === 0) {
        focus = renderer?.currentFocusedRenderable ?? null
        focus?.blur()
      }
      setStore("stack", [...store.stack, { element: thunk, onClose }])
    },
    pop() {
      const current = store.stack.at(-1)
      current?.onClose?.()
      setStore("stack", store.stack.slice(0, -1))
      if (store.stack.length === 0) refocus()
    },
    get stack() {
      return store.stack
    },
    get size() {
      return store.size
    },
    setSize(size: DialogSize) {
      setStore("size", size)
    },
  }
}

export type DialogContext = ReturnType<typeof init>

const ctx = createContext<DialogContext>()

export function DialogProvider(props: ParentProps) {
  const value = init()

  return (
    <ctx.Provider value={value}>
      {props.children}
      <box position="absolute" zIndex={3000}>
        <Show when={value.stack.length}>
          <Dialog onClose={() => value.clear()} size={value.size}>
            {value.stack.at(-1)!.element()}
          </Dialog>
        </Show>
      </box>
    </ctx.Provider>
  )
}

export function useDialog(): DialogContext {
  const value = useContext(ctx)
  if (!value) throw new Error("useDialog must be used within a DialogProvider")
  return value
}
