/**
 * Unit tests for the composer key router at
 * `src/tui/chat/composer/key-router.ts` — the pure decision paths of
 * `handleKeyDown` / `handleSubmit` / `handleContentChange` driven with
 * mock callbacks and a fake textarea (no opentui, no real engine).
 *
 * The Ctrl+R palette is an injected seam (`showHistoryPalette`), so the
 * router is framework-free and imports cleanly under vitest.
 */

import type { KeyEvent } from "@opentui/core"
import { beforeAll, describe, expect, test, vi } from "vitest"

// Never touch the real ~/.kobe history store from a submit path.
process.env.KOBE_HISTORY_PERSIST = "false"

import { createKeyRouter } from "../../src/tui/chat/composer/key-router"

type Deps = Parameters<typeof createKeyRouter>[0]

function key(partial: Partial<KeyEvent> & { preventDefault?: () => void }): KeyEvent {
  return {
    name: "",
    sequence: "",
    ctrl: false,
    meta: false,
    super: false,
    shift: false,
    preventDefault: vi.fn(),
    ...partial,
  } as unknown as KeyEvent
}

function makeTextarea(text = "", cursor = text.length) {
  return {
    plainText: text,
    cursorOffset: cursor,
    setText(t: string) {
      this.plainText = t
      this.cursorOffset = t.length
    },
  }
}

function signal<T>(init: T): [() => T, (v: T | ((prev: T) => T)) => void] {
  let val = init
  return [
    () => val,
    (v) => {
      val = typeof v === "function" ? (v as (prev: T) => T)(val) : v
    },
  ]
}

function build(opts: {
  textarea?: ReturnType<typeof makeTextarea>
  bashMode?: boolean
  bashAvailable?: boolean
  liveBuffer?: string
  slashOpen?: boolean
  slashMatches?: readonly { display: string; onSelect: () => void }[]
  slashCursor?: number
  historyNav?: Partial<Deps["historyNav"]>
  imageRegistry?: Partial<Deps["imageRegistry"]>
  props?: Partial<Deps["props"]>
}) {
  const textarea = opts.textarea ?? makeTextarea()
  const [bashMode, setBashMode] = signal(opts.bashMode ?? false)
  const [liveBuffer, setLiveBuffer] = signal(opts.liveBuffer ?? "")
  const [slashCursor, setSlashCursor] = signal(opts.slashCursor ?? 0)
  const [pasteHint, setPasteHint] = signal<string | null>(null)
  const setLiveCursor = vi.fn()
  const setBuffer = vi.fn()

  const historyNav = {
    isActive: () => false,
    reset: vi.fn(),
    prev: vi.fn(() => false),
    next: vi.fn(() => false),
    ...opts.historyNav,
  }
  const imageRegistry = {
    hasEntries: () => false,
    expand: (s: string) => s,
    clear: vi.fn(),
    ...opts.imageRegistry,
  }
  const props = {
    onDraftChange: vi.fn(),
    onSubmit: vi.fn(),
    onBashCommand: vi.fn(),
    historyKey: "tab-1",
    currentProjectRoot: () => undefined,
    ...opts.props,
  }

  const deps = {
    props,
    showHistoryPalette: vi.fn(async () => undefined),
    getTextarea: () => textarea,
    bashMode,
    setBashMode: vi.fn(setBashMode),
    bashAvailable: () => opts.bashAvailable ?? true,
    liveBuffer,
    setLiveBuffer: vi.fn(setLiveBuffer),
    setLiveCursor,
    setBuffer,
    slashOpen: () => opts.slashOpen ?? false,
    slashMatches: () => opts.slashMatches ?? [],
    slashCursor,
    setSlashCursor: vi.fn(setSlashCursor),
    mention: { handleKeyDown: () => false },
    historyNav,
    imageRegistry,
    pasteHint,
    setPasteHint: vi.fn(setPasteHint),
    applyHistoryRecall: vi.fn(),
    tryAttachClipboardImage: vi.fn(async () => {}),
  } as unknown as Deps

  return { router: createKeyRouter(deps), deps, textarea, slashCursor }
}

describe("handleKeyDown", () => {
  test("empty buffer + `!` enters bash mode and swallows the key", () => {
    const { router, deps } = build({ liveBuffer: "" })
    const k = key({ sequence: "!" })
    router.handleKeyDown(k)
    expect(deps.setBashMode).toHaveBeenCalledWith(true)
    expect(k.preventDefault).toHaveBeenCalled()
  })

  test("backspace on empty bash buffer exits bash mode", () => {
    const { router, deps } = build({ bashMode: true, liveBuffer: "" })
    router.handleKeyDown(key({ name: "backspace" }))
    expect(deps.setBashMode).toHaveBeenCalledWith(false)
  })

  test("ctrl+enter submits as steer when the dropdown is closed", () => {
    const { router, deps } = build({ textarea: makeTextarea("hello") })
    router.handleKeyDown(key({ name: "return", ctrl: true }))
    expect(deps.props.onSubmit).toHaveBeenCalledWith("hello", "steer")
  })

  test("shift+tab cycles permission mode when a cycler is threaded", () => {
    const onCyclePermissionMode = vi.fn()
    const { router } = build({ props: { onCyclePermissionMode } })
    router.handleKeyDown(key({ name: "tab", shift: true }))
    expect(onCyclePermissionMode).toHaveBeenCalled()
  })

  test("ctrl+v routes to the clipboard-image attach path", () => {
    const { router, deps } = build({})
    router.handleKeyDown(key({ name: "v", ctrl: true }))
    expect(deps.tryAttachClipboardImage).toHaveBeenCalled()
  })

  test("down arrow moves the slash cursor when the dropdown is open", () => {
    const matches = [
      { display: "/a", onSelect: vi.fn() },
      { display: "/b", onSelect: vi.fn() },
    ]
    const { router, slashCursor } = build({ slashOpen: true, slashMatches: matches, slashCursor: 0 })
    router.handleKeyDown(key({ name: "down" }))
    expect(slashCursor()).toBe(1)
  })

  test("ctrl+r opens the injected history palette and applies the pick", async () => {
    // The palette is a framework seam (issue #15 G3): the router only knows
    // the promise contract, so both the Solid and React composers can wire
    // their own dialog stacks in.
    const { router, deps } = build({})
    ;(deps.showHistoryPalette as ReturnType<typeof vi.fn>).mockResolvedValueOnce("!ls -la")
    const k = key({ name: "r", ctrl: true })
    router.handleKeyDown(k)
    expect(deps.showHistoryPalette).toHaveBeenCalledWith(
      expect.objectContaining({ currentProject: undefined, taskLabelFor: expect.any(Function) }),
    )
    expect(k.preventDefault).toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 0)) // let the .then(applyHistoryRecall) hop settle
    expect(deps.applyHistoryRecall).toHaveBeenCalledWith("!ls -la")
  })

  test("up arrow at the first line recalls prior history", () => {
    const prev = vi.fn(() => true)
    const { router } = build({ textarea: makeTextarea("abc", 0), historyNav: { prev } })
    const k = key({ name: "up" })
    router.handleKeyDown(k)
    expect(prev).toHaveBeenCalled()
    expect(k.preventDefault).toHaveBeenCalled()
  })
})

describe("handleSubmit", () => {
  test("submits the trimmed buffer in auto mode", () => {
    const { router, deps } = build({ textarea: makeTextarea("  hi  ") })
    router.handleSubmit()
    expect(deps.props.onSubmit).toHaveBeenCalledWith("hi", "auto")
  })

  test("bash mode routes the command to onBashCommand and clears", () => {
    const ta = makeTextarea("ls -la")
    const { router, deps } = build({ bashMode: true, textarea: ta })
    router.handleSubmit()
    expect(deps.props.onBashCommand).toHaveBeenCalledWith("ls -la")
    expect(deps.setBashMode).toHaveBeenCalledWith(false)
    expect(ta.plainText).toBe("")
  })

  test("open slash dropdown runs the highlighted entry instead of submitting", () => {
    const onSelect = vi.fn()
    const { router, deps } = build({
      slashOpen: true,
      slashMatches: [{ display: "/compact", onSelect }],
      slashCursor: 0,
      textarea: makeTextarea("/comp"),
    })
    router.handleSubmit()
    expect(onSelect).toHaveBeenCalled()
    expect(deps.props.onSubmit).not.toHaveBeenCalled()
  })
})

describe("handleContentChange", () => {
  test("mirrors the textarea into the live buffer and notifies the parent", () => {
    const { router, deps } = build({ textarea: makeTextarea("draft") })
    router.handleContentChange()
    expect(deps.setLiveBuffer).toHaveBeenCalledWith("draft")
    expect(deps.props.onDraftChange).toHaveBeenCalledWith("draft")
  })
})

beforeAll(() => {
  // Sanity: the router factory returns the three handlers.
  const { router } = build({})
  expect(typeof router.handleKeyDown).toBe("function")
  expect(typeof router.handleSubmit).toBe("function")
  expect(typeof router.handleContentChange).toBe("function")
})
