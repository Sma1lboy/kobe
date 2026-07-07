/** @jsxImportSource @opentui/react */
/**
 * Render-track test harness — mount a REAL opentui React component and
 * assert on its actual rendered frame / keyboard interaction.
 *
 * Why `bun test`, not vitest: opentui components (`src/**\/*.tsx`) can't run
 * under vitest's node environment — `@opentui/core` ships raw `.scm`/`.wasm`
 * assets via `with { type: "file" }` imports node's loader can't resolve, and
 * `bun build --compile`'s reconciler needs the bun runtime. `@opentui/react`'s
 * `testRender` mounts a component against a real headless renderer under bun;
 * this whole directory is invisible to vitest (see vitest.config.ts's
 * `test/render/**` exclusion) and runs via `bun test` (`test:render`).
 *
 * Usage:
 *
 *   import { renderComponent } from "./harness"
 *
 *   test("shows the confirm title", async () => {
 *     const { frame, mockInput } = await renderComponent(
 *       <MyDialog title="Delete task?" />,
 *       { providers: { dialog: true } },
 *     )
 *     expect(await frame()).toContain("Delete task?")
 *     mockInput.pressEnter()
 *     expect(await frame()).toContain("...")
 *   })
 */

import { afterEach } from "bun:test"
import { EventEmitter } from "node:events"
import type { CapturedFrame } from "@opentui/core"
import type { MockInput, MockMouse, TestRenderer } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { type ReactNode, act } from "react"
import { FocusProvider } from "../../src/tui-react/context/focus"
import { KVProvider } from "../../src/tui-react/context/kv"
import { NotificationsProvider } from "../../src/tui-react/context/notifications"
import { ThemeProvider } from "../../src/tui-react/context/theme"
import { DialogProvider } from "../../src/tui-react/ui/dialog"

export { act }

/** Which ambient providers to mount around the component under test. All default off except `theme`. */
export interface ProviderFlags {
  /** `<ThemeProvider theme="claude">`. Default true — nearly every component reads `useTheme()`. */
  theme?: boolean
  /** `<KVProvider>` — persisted UI state. Reads/writes `$KOBE_HOME_DIR/.config/kobe/state.json`; set that env var in a test that enables this. Default false. */
  kv?: boolean
  /** `<FocusProvider>` — pane focus context. Default false. */
  focus?: boolean
  /** `<DialogProvider>` — the dialog stack (`useDialog()`). Required by every `*Dialog` component. Default false. */
  dialog?: boolean
  /** `<NotificationsProvider>` — toast queue (`useNotifications()`). Default false. */
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
  /** Flush pending render passes and return the captured char-grid frame as a string. */
  frame: () => Promise<string>
  /** Flush pending render passes without capturing — use between `mockInput` actions when only the final frame matters. */
  rerender: () => Promise<void>
  /** Flush pending render passes and return the captured frame with per-span colors/attributes — for assertions that need actual fg/bg. */
  spans: () => Promise<CapturedFrame>
  resize: (width: number, height: number) => void
  destroy: () => void
}

// Tracks the most recently created renderer so `afterEach` can destroy it even
// if a test forgets to (or fails before its own destroy). `renderer.destroy()`
// runs the React root's `unmount()` inside act(), so component effect cleanups
// (e.g. the module-level `useBindings` stack) drain between tests — otherwise
// stale key handlers leak across tests in the same file.
let liveRenderer: TestRenderer | null = null

// opentui/core's process-wide TerminalConsoleCache singleton picks up one
// listener per `testRender()`; a file with >10 tests trips Node's default
// max-listener warning even though every renderer is destroyed. Cosmetic —
// bump the ceiling rather than chase a leak that isn't one.
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

/** Wrap `ui` in the requested providers, innermost-to-outermost: Theme > KV > Focus > Dialog > Notifications — the same nesting the real pane hosts mount. */
function withProviders(ui: ReactNode, flags: ProviderFlags | undefined): ReactNode {
  const { theme = true, kv = false, focus = false, dialog = false, notifications = false } = flags ?? {}
  let node = ui
  if (notifications) node = <NotificationsProvider>{node}</NotificationsProvider>
  if (dialog) node = <DialogProvider>{node}</DialogProvider>
  if (focus) node = <FocusProvider>{node}</FocusProvider>
  if (kv) node = <KVProvider>{node}</KVProvider>
  if (theme) node = <ThemeProvider theme="claude">{node}</ThemeProvider>
  return node
}

/**
 * Wait out opentui's raw-mode escape-sequence disambiguation window. A lone
 * ESC byte is ambiguous with the start of a multi-byte escape sequence (arrow
 * keys, `alt+`, kitty chords all start with `\x1B`), so the parser holds it
 * briefly before deciding it was a standalone Escape. `mockInput.pressEscape()`
 * writes the byte synchronously but the resulting `keypress` event doesn't fire
 * until that window closes — call `await settle()` before the next assertion.
 */
export function settle(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Mount `ui` against a real opentui React test renderer and return a handle to
 * drive/inspect it. Renders one initial frame before resolving, so `frame()`
 * immediately after `renderComponent()` reflects the mounted state.
 */
export async function renderComponent(ui: ReactNode, options: RenderOptions = {}): Promise<RenderHandle> {
  const { width = 80, height = 24, providers } = options
  const wrapped = withProviders(ui, providers)
  const { renderer, mockInput, mockMouse, flush, captureCharFrame, captureSpans, resize } = await testRender(wrapped, {
    width,
    height,
  })
  liveRenderer = renderer
  await flush()

  return {
    renderer,
    mockInput,
    mockMouse,
    frame: async () => {
      await flush()
      return captureCharFrame()
    },
    rerender: async () => {
      await flush()
    },
    spans: async () => {
      await flush()
      return captureSpans()
    },
    resize,
    destroy: () => {
      renderer.destroy()
      if (liveRenderer === renderer) liveRenderer = null
    },
  }
}
