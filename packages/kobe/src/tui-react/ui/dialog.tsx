/** @jsxImportSource @opentui/react */

import { RGBA, type Renderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/react"
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useTheme } from "../context/theme"
import { useBindings } from "../lib/keymap"

export type DialogSize = "small" | "medium" | "large" | "xlarge"

const DIALOG_BACKDROP = RGBA.fromInts(0, 0, 0, 128)
const TRANSPARENT_DIALOG_BACKDROP = RGBA.fromInts(0, 0, 0, 64)

export function Dialog(props: { children?: ReactNode; size?: DialogSize; onClose: () => void }) {
  const dimensions = useTerminalDimensions()
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const renderer = useRenderer()

  const dismissRef = useRef(false)
  const width = props.size === "xlarge" ? 140 : props.size === "large" ? 110 : props.size === "small" ? 50 : 80

  const VERTICAL_MARGIN = 2
  const maxCardHeight = Math.max(8, dimensions.height - VERTICAL_MARGIN * 2)

  return (
    <box
      onMouseDown={() => {
        dismissRef.current = !!renderer?.getSelection()
      }}
      onMouseUp={() => {
        if (dismissRef.current) {
          dismissRef.current = false
          return
        }
        props.onClose?.()
      }}
      width={dimensions.width}
      height={dimensions.height}
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
          dismissRef.current = false
          e.stopPropagation()
        }}
        width={width}
        maxWidth={dimensions.width - 2}
        maxHeight={maxCardHeight}
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

type StackEntry = { element: () => ReactNode; onClose?: () => void }

export type DialogContext = {
  clear(): void
  replace(thunk: () => ReactNode, onClose?: () => void): void
  push(thunk: () => ReactNode, onClose?: () => void): void
  pop(): void
  readonly stack: readonly StackEntry[]
  readonly size: DialogSize
  setSize(size: DialogSize): void
}

const ctx = createContext<DialogContext | null>(null)

export function DialogProvider(props: { children?: ReactNode }) {
  const [stack, setStack] = useState<readonly StackEntry[]>([])
  const [size, setSize] = useState<DialogSize>("medium")
  const renderer = useRenderer()

  const focusRef = useRef<Renderable | null>(null)
  const refocusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (refocusTimer.current) clearTimeout(refocusTimer.current)
    },
    [],
  )

  const refocus = useCallback(() => {
    if (refocusTimer.current) clearTimeout(refocusTimer.current)
    refocusTimer.current = setTimeout(() => {
      const focus = focusRef.current
      if (!focus || focus.isDestroyed) return
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
  }, [renderer])

  const stackRef = useRef(stack)
  stackRef.current = stack

  const captureFocusIfFirst = useCallback(() => {
    if (stackRef.current.length === 0) {
      focusRef.current = renderer?.currentFocusedRenderable ?? null
      focusRef.current?.blur()
    }
  }, [renderer])

  const dismissTop = useCallback(() => {
    if (renderer?.getSelection()) renderer.clearSelection()
    const current = stackRef.current.at(-1)
    current?.onClose?.()
    setStack((s) => s.slice(0, -1))
    refocus()
  }, [renderer, refocus])

  useBindings(() => ({
    enabled: stackRef.current.length > 0 && !renderer?.getSelection()?.getSelectedText(),
    bindings: [
      { key: "escape", cmd: dismissTop },
      { key: "ctrl+c", cmd: dismissTop },
    ],
  }))

  const value = useMemo<DialogContext>(
    () => ({
      clear() {
        for (const item of stackRef.current) item.onClose?.()
        setSize("medium")
        setStack([])
        refocus()
      },
      replace(thunk, onClose) {
        captureFocusIfFirst()
        for (const item of stackRef.current) item.onClose?.()
        setSize("medium")
        setStack([{ element: thunk, onClose }])
      },
      push(thunk, onClose) {
        captureFocusIfFirst()
        setStack((s) => [...s, { element: thunk, onClose }])
      },
      pop() {
        const current = stackRef.current.at(-1)
        current?.onClose?.()
        setStack((s) => s.slice(0, -1))
        if (stackRef.current.length <= 1) refocus()
      },
      get stack() {
        return stackRef.current
      },
      get size() {
        return size
      },
      setSize,
    }),
    [size, refocus, captureFocusIfFirst],
  )

  const top = stack.at(-1)
  return (
    <ctx.Provider value={value}>
      {props.children}
      <box position="absolute" zIndex={3000}>
        {top ? (
          <Dialog onClose={() => value.clear()} size={size}>
            {top.element()}
          </Dialog>
        ) : null}
      </box>
    </ctx.Provider>
  )
}

export function useDialog(): DialogContext {
  const value = useContext(ctx)
  if (!value) throw new Error("useDialog must be used within a DialogProvider")
  return value
}
