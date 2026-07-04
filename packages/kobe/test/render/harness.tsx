/**
 * Render-track test harness — mount a REAL opentui Solid component and
 * assert on its actual rendered frame / keyboard interaction.
 *
 * Why `bun test`, not vitest: opentui Solid components (`src/**\/*.tsx`)
 * cannot execute under vitest's node environment at all — `@opentui/core`
 * ships raw `.scm`/`.wasm` assets via `with { type: "file" }` imports that
 * node's loader can't resolve, and the JSX needs `@opentui/solid`'s
 * Babel-driven transform, not vitest's default. `bun test --preload
 * @opentui/solid/preload` is the one runner where both resolve natively
 * (verified: spike-artifacts/tsx-render.spike.bun.test.tsx). Their `.test.ts`
 * sibling required a hand-rolled JSX bridge + asset stubs and is not worth
 * carrying forward. See docs/HARNESS.md "render track" and vitest.config.ts's
 * `test/render/**` exclusion (this whole directory is invisible to vitest).
 *
 * Usage:
 *
 *   import { renderComponent } from "./harness"
 *
 *   test("shows the confirm title", async () => {
 *     const { frame, mockInput, destroy } = await renderComponent(
 *       () => <MyDialog title="Delete task?" />,
 *       { providers: { dialog: true } },
 *     )
 *     expect(await frame()).toContain("Delete task?")
 *     mockInput.pressKey("return")
 *     expect(await frame()).toContain("...")
 *     destroy() // optional — afterEach also cleans up any renderer left open
 *   })
 */

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

/** Which ambient providers to mount around the component under test. All default off except `theme`. */
export interface ProviderFlags {
  /** `<ThemeProvider theme="claude">`. Default true — nearly every component reads `useTheme()`. */
  theme?: boolean
  /** `<KVProvider>` — persisted UI state. Reads/writes `~/.config/kobe/state.json` (or `$KOBE_HOME_DIR`); set that env var in a test that enables this. Default false. */
  kv?: boolean
  /** `<FocusProvider>` — pane focus context. Default false. */
  focus?: boolean
  /** `<DialogProvider>` — the dialog stack (`useDialog()`). Required by every `*Dialog`/`*Composer` component. Default false. */
  dialog?: boolean
  /** `<NotificationsProvider>` — toast queue (`useNotifications()`). Implies `kv` (NotificationsProvider reads `useKV()`). Default false. */
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
  /** Flush a render pass and return the captured char-grid frame as a string. */
  frame: () => Promise<string>
  /** Flush a render pass without capturing — use between multiple `mockInput` actions when only the final frame matters. */
  rerender: () => Promise<void>
  /** Flush a render pass and return the captured frame with per-span colors/attributes — for assertions that need actual fg/bg (a text frame is colorless). */
  spans: () => Promise<CapturedFrame>
  resize: (width: number, height: number) => void
  destroy: () => void
}

// Tracks the most recently created renderer so `afterEach` can destroy it
// even if a test forgets to (or fails before reaching its own destroy()) —
// opentui renderers hold real timers/listeners and leak across tests
// otherwise. Single-slot is enough: render tests never overlap two
// renderers within one test.
let liveRenderer: TestRenderer | null = null

// opentui/core's process-wide `TerminalConsoleCache` singleton picks up one
// listener per `testRender()` call; a render-track file with more than 10
// tests trips Node's default max-listener warning even though every
// renderer is destroyed in `afterEach`. Cosmetic only — bump the ceiling
// rather than chase a leak that isn't one.
EventEmitter.defaultMaxListeners = 200

afterEach(() => {
  if (!liveRenderer) return
  try {
    liveRenderer.destroy()
  } catch {
    // already destroyed by the test itself — fine
  }
  liveRenderer = null
})

/** Wrap `ui` in the requested providers, innermost-to-outermost: Theme > KV > Focus > Dialog > Notifications — the same nesting order `lib/host-boot.tsx` mounts for every real pane host. */
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

/**
 * Wait out opentui's raw-mode escape-sequence disambiguation window. A lone
 * ESC byte is ambiguous with the start of a multi-byte escape sequence
 * (arrow keys, `alt+`, kitty-protocol chords all start with `\x1B`), so the
 * parser holds it briefly before deciding it was a standalone Escape key.
 * `mockInput.pressEscape()` writes the byte synchronously but the resulting
 * `keypress` event (and therefore any `useBindings` escape handler) doesn't
 * fire until that window closes — call `await settle()` before the next
 * `frame()`/assertion or the escape will appear to have done nothing.
 */
export function settle(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Mount `ui` against a real opentui test renderer and return a handle to
 * drive/inspect it. Always renders one initial frame before resolving, so
 * `frame()` immediately after `renderComponent()` reflects the mounted
 * state without a redundant extra call.
 */
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
