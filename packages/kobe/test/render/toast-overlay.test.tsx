import { describe, expect, it } from "bun:test"
import { ToastOverlay } from "../../src/tui/component/toast-overlay"
import { useNotifications } from "../../src/tui/context/notifications"
import { renderComponent } from "./harness"

process.env.KOBE_HOME_DIR = process.env.KOBE_HOME_DIR ?? "/tmp/kobe-render-test-home"

function NotifyProbe(props: { kind: "done" | "needs_input" | "error"; title: string }) {
  const notif = useNotifications()
  notif.notify({ kind: props.kind, taskId: "t1", tabId: "tab1", title: props.title })
  return <ToastOverlay />
}

describe("ToastOverlay", () => {
  it("renders nothing with no toasts queued", async () => {
    const { frame } = await renderComponent(() => <ToastOverlay />, { providers: { notifications: true } })
    expect((await frame()).trim().length).toBe(0)
  })

  it("shows a done toast with its title and a check prefix", async () => {
    const { frame } = await renderComponent(() => <NotifyProbe kind="done" title="build finished" />, {
      providers: { notifications: true },
    })
    const text = await frame()
    expect(text).toContain("build finished")
    expect(text).toContain("✓")
  })

  it("shows an error toast with an X prefix", async () => {
    const { frame } = await renderComponent(() => <NotifyProbe kind="error" title="clone failed" />, {
      providers: { notifications: true },
    })
    const text = await frame()
    expect(text).toContain("clone failed")
    expect(text).toContain("✕")
  })
})
