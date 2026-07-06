import { afterEach } from "bun:test"
import { EventEmitter } from "node:events"
import type { CapturedFrame } from "@opentui/core"
import type { MockInput, MockMouse, TestRenderer } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import { FocusProvider } from "../../src/tui/context/focus"
import { KVProvider } from "../../src/tui/context/kv"
import { NotificationsProvider } from "../../src/tui/context/notifications"
import { ThemeProvider } from "../../src/tui/context/theme"
import { DialogProvider } from "../../src/tui/ui/dialog"

export interface ProviderFlags {
  theme?: boolean
  kv?: boolean
  focus?: boolean
  dialog?: boolean
  notifications?: boolean
}

export interface RenderOptions {
  width?: number
  height?: number
  providers?: ProviderFlags
}

export interface RenderHandle {
  renderer: TestRenderer
  mockInput: MockInput
  mockMouse: MockMouse
  frame: () => Promise<string>
  rerender: () => Promise<void>
  spans: () => Promise<CapturedFrame>
  resize: (width: number, height: number) => void
  destroy: () => void
}

let liveRenderer: TestRenderer | null = null

EventEmitter.defaultMaxListeners = 200

afterEach(() => {
  if (!liveRenderer) return
  try {
    liveRenderer.destroy()
  } catch {}
  liveRenderer = null
})

function withProviders(ui: () => JSX.Element, flags: ProviderFlags | undefined): () => JSX.Element {
  const { theme = true, kv = false, focus = false, dialog = false, notifications = false } = flags ?? {}
  let node = ui
  if (notifications) {
    const inner = node
    node = () => <NotificationsProvider>{inner()}</NotificationsProvider>
  }
  if (dialog) {
    const inner = node
    node = () => <DialogProvider>{inner()}</DialogProvider>
  }
  if (focus) {
    const inner = node
    node = () => <FocusProvider>{inner()}</FocusProvider>
  }
  if (kv || notifications) {
    const inner = node
    node = () => <KVProvider>{inner()}</KVProvider>
  }
  if (theme) {
    const inner = node
    node = () => <ThemeProvider theme="claude">{inner()}</ThemeProvider>
  }
  return node
}

export function settle(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function renderComponent(ui: () => JSX.Element, options: RenderOptions = {}): Promise<RenderHandle> {
  const { width = 80, height = 24, providers } = options
  const wrapped = withProviders(ui, providers)
  const { renderer, mockInput, mockMouse, renderOnce, captureCharFrame, captureSpans, resize } = await testRender(
    wrapped,
    { width, height },
  )
  liveRenderer = renderer
  await renderOnce()

  return {
    renderer,
    mockInput,
    mockMouse,
    frame: async () => {
      await renderOnce()
      return captureCharFrame()
    },
    rerender: async () => {
      await renderOnce()
    },
    spans: async () => {
      await renderOnce()
      return captureSpans()
    },
    resize,
    destroy: () => {
      renderer.destroy()
      if (liveRenderer === renderer) liveRenderer = null
    },
  }
}
