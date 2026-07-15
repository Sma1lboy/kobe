/** @jsxImportSource @opentui/react */
/**
 * ToastOverlay — bottom-right transient toast stack
 * (src/tui-react/component/toast-overlay.tsx). Exercises the real
 * NotificationsProvider (notify/dismiss), not a mock — the actual
 * (kind -> chip) wiring the pane hosts rely on.
 */
import { describe, expect, it } from "bun:test"
import { type CapturedFrame, RGBA } from "@opentui/core"
import { useEffect } from "react"
import { ToastOverlay } from "../../src/tui-react/component/toast-overlay"
import { useNotifications } from "../../src/tui-react/context/notifications"
import { type InboxRpcAction, notifyInboxRpcFailure } from "../../src/tui-react/workspace/inbox-rpc-errors"
import { BUNDLED_THEME_JSONS } from "../../src/tui/context/theme/bundled"
import { resolveThemeSlotHex } from "../../src/tui/context/theme/hex"
import { act, renderComponent } from "./harness"

// The notifications provider reads a one-shot state.json snapshot for the
// sound/toast toggles; point it at a throwaway dir so the test never touches
// (or depends on) a real ~/.config/kobe/state.json.
process.env.KOBE_HOME_DIR = process.env.KOBE_HOME_DIR ?? "/tmp/kobe-render-test-home"

function NotifyProbe(props: { kind: "done" | "needs_input" | "error"; title: string }) {
  const notif = useNotifications()
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once notify.
  useEffect(() => {
    notif.notify({ kind: props.kind, taskId: "t1", tabId: "tab1", title: props.title })
  }, [])
  return <ToastOverlay />
}

function InboxRejectProbe(props: { action: InboxRpcAction; onReady: (reject: () => void) => void }) {
  const notif = useNotifications()
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once test control.
  useEffect(() => {
    props.onReady(() => {
      notifyInboxRpcFailure(Promise.reject(new Error("daemon exploded")), props.action, (title) => {
        notif.notify({ kind: "error", taskId: "t1", tabId: "tab1", title })
      })
    })
  }, [])
  return <ToastOverlay />
}

function findSpan(frame: CapturedFrame, needle: string) {
  return frame.lines.flatMap((line) => line.spans).find((span) => span.text.includes(needle))
}

describe("ToastOverlay", () => {
  it("renders nothing with no toasts queued", async () => {
    const { frame } = await renderComponent(<ToastOverlay />, { providers: { notifications: true } })
    expect((await frame()).trim().length).toBe(0)
  })

  it("shows a done toast with its title and a check prefix", async () => {
    const { frame } = await renderComponent(<NotifyProbe kind="done" title="build finished" />, {
      providers: { notifications: true },
    })
    const text = await frame()
    expect(text).toContain("build finished")
    expect(text).toContain("✓")
  })

  it("shows an error toast with an X prefix", async () => {
    const { frame } = await renderComponent(<NotifyProbe kind="error" title="clone failed" />, {
      providers: { notifications: true },
    })
    const text = await frame()
    expect(text).toContain("clone failed")
    expect(text).toContain("✕")
  })

  it.each([
    ["mark read", "Couldn't mark read: daemon exploded"],
    ["dismiss", "Couldn't dismiss: daemon exploded"],
  ] as const)("renders a string error toast when Inbox %s RPC rejects", async (action, expected) => {
    let reject = () => {}
    const { frame } = await renderComponent(
      <InboxRejectProbe
        action={action}
        onReady={(run) => {
          reject = run
        }}
      />,
      { providers: { notifications: true } },
    )
    await act(async () => {
      reject()
      await Promise.resolve()
    })
    expect(await frame()).toContain(expected)
  })

  it.each([
    ["done", "success", "✓"],
    ["needs_input", "warning", "?"],
    ["error", "error", "✕"],
  ] as const)("uses a neutral surface, readable title, and %s semantic glyph", async (kind, colorSlot, prefix) => {
    const theme = BUNDLED_THEME_JSONS.claude!
    const bgHex = resolveThemeSlotHex(theme, "backgroundElement")
    const textHex = resolveThemeSlotHex(theme, "text")
    const semanticHex = resolveThemeSlotHex(theme, colorSlot)
    expect(bgHex).not.toBeNull()
    expect(textHex).not.toBeNull()
    expect(semanticHex).not.toBeNull()

    const { spans } = await renderComponent(<NotifyProbe kind={kind} title={`${kind} notice`} />, {
      providers: { notifications: true },
    })
    const frame = await spans()
    const titleSpan = findSpan(frame, `${kind} notice`)
    const prefixSpan = findSpan(frame, prefix)

    expect(titleSpan?.bg.equals(RGBA.fromHex(bgHex!))).toBe(true)
    expect(titleSpan?.fg.equals(RGBA.fromHex(textHex!))).toBe(true)
    expect(prefixSpan?.fg.equals(RGBA.fromHex(semanticHex!))).toBe(true)
  })
})
