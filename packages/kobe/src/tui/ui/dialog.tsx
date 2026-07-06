import { RGBA, type Renderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { type JSX, type ParentProps, Show, batch, createContext, useContext } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../context/theme"
import { useBindings } from "../lib/keymap"
import { createManagedTimeouts } from "../lib/managed-timeout"

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
  const width = () => {
    if (props.size === "xlarge") return 140
    if (props.size === "large") return 110
    if (props.size === "small") return 50
    return 80
  }

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
        flexGrow={0}
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
  const timeouts = createManagedTimeouts()

  function refocus() {
    timeouts.set(() => {
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

  const dismissTop = () => {
    if (renderer?.getSelection()) renderer.clearSelection()
    const current = store.stack.at(-1)
    current?.onClose?.()
    setStore("stack", store.stack.slice(0, -1))
    refocus()
  }

  useBindings(() => ({
    enabled: store.stack.length > 0 && !renderer?.getSelection()?.getSelectedText(),
    bindings: [
      { key: "escape", cmd: dismissTop },
      { key: "ctrl+c", cmd: dismissTop },
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
