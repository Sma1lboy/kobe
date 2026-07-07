/** @jsxImportSource @opentui/react */
/**
 * ToastOverlay — bottom-right transient toast stack
 * (src/tui-react/component/toast-overlay.tsx). Exercises the real
 * NotificationsProvider (notify/dismiss), not a mock — the actual
 * (kind -> chip) wiring the pane hosts rely on.
 */
import { describe, expect, it } from "bun:test"
import { useEffect } from "react"
import { ToastOverlay } from "../../src/tui-react/component/toast-overlay"
import { useNotifications } from "../../src/tui-react/context/notifications"
import { renderComponent } from "./harness"

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
})
