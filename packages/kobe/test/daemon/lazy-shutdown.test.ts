import { existsSync } from "node:fs"
import { afterEach, describe, expect, it } from "vitest"
import { type DaemonHarness, bootDaemonHarness, waitFor } from "./harness.ts"

/**
 * Refcounted lazy shutdown: the daemon's lifetime is bound to the number of
 * attached GUIs — front-ends that subscribed with `role: "gui"`. The last gui
 * leaving arms a short grace, then the daemon self-stops. Two kinds of client
 * must NOT count: transient CLI pokes (hello-only, never subscribed) and
 * in-tmux helper panes (`role: "pane"` — they subscribe for push channels but
 * persist with the tmux session after the user quits). These exercise the real
 * socket path end to end under the `test:socket` pool.
 */

const GRACE_MS = 80

describe("daemon refcounted lazy shutdown", () => {
  let h: DaemonHarness

  afterEach(async () => {
    await h.close()
  })

  /** Boot with the short grace window every test here relies on. */
  function boot(): Promise<DaemonHarness> {
    return bootDaemonHarness({ env: { KOBE_DAEMON_IDLE_GRACE_MS: String(GRACE_MS) } })
  }

  it("self-stops a grace period after the last subscriber disconnects", async () => {
    h = await boot()
    const client = h.client()
    await client.request("hello")
    await client.subscribe({ role: "gui" })
    // A subscribed GUI is attached → daemon must NOT be tearing down yet.
    expect(existsSync(h.socketPath)).toBe(true)

    client.close()
    // Last GUI gone → grace timer fires → close() unlinks the socket + pidfile.
    expect(await waitFor(() => !existsSync(h.socketPath), GRACE_MS + 500)).toBe(true)
    expect(await waitFor(() => !existsSync(h.pidPath), 500)).toBe(true)
  })

  it("stays up for a transient, never-subscribed connection", async () => {
    h = await boot()
    const poke = h.client()
    await poke.request("hello")
    await poke.request("daemon.status")
    poke.close()

    // Wait past the grace window; a non-GUI socket never armed the timer.
    await new Promise((r) => setTimeout(r, GRACE_MS + 150))
    expect(existsSync(h.socketPath)).toBe(true)
  })

  it("stays up for a transient, never-subscribed connection (default subscribe is pane)", async () => {
    h = await boot()
    // A bare subscribe() (no role) is a "pane": it must NOT keep the daemon
    // alive. This is the bug — N ChatTab Tasks panes subscribed and the count
    // never hit 0 on quit, so the daemon never idle-stopped.
    const pane = h.client()
    await pane.subscribe()
    pane.close()
    // No gui ever attached → nothing armed the timer → daemon holds (a pane
    // closing must not stop it either, but no gui means it just stays up).
    await new Promise((r) => setTimeout(r, GRACE_MS + 150))
    expect(existsSync(h.socketPath)).toBe(true)
    pane.close()
  })

  it("panes never hold the daemon alive after the gui quits", async () => {
    h = await boot()
    // The real-world shape: one gui front-end + several in-tmux Tasks panes.
    const gui = h.client()
    const pane1 = h.client()
    const pane2 = h.client()
    await gui.subscribe({ role: "gui" })
    await pane1.subscribe({ role: "pane" })
    await pane2.subscribe({ role: "pane" })

    // User quits kobe → only the gui socket drops. Panes stay subscribed
    // (the tmux session persists), but the daemon must still self-stop.
    gui.close()
    expect(await waitFor(() => !existsSync(h.socketPath), GRACE_MS + 500)).toBe(true)
    pane1.close()
    pane2.close()
  })

  it("a pane subscribing during the grace window does NOT cancel shutdown", async () => {
    h = await boot()
    const gui = h.client()
    await gui.subscribe({ role: "gui" })
    gui.close() // arms the grace timer

    // A pane connecting mid-grace must not rescue the daemon — only a gui can.
    const pane = h.client()
    await pane.subscribe({ role: "pane" })

    expect(await waitFor(() => !existsSync(h.socketPath), GRACE_MS + 500)).toBe(true)
    pane.close()
  })

  it("only stops once the LAST of several subscribers leaves", async () => {
    h = await boot()
    const a = h.client()
    const b = h.client()
    await a.subscribe({ role: "gui" })
    await b.subscribe({ role: "gui" })

    a.close()
    // One GUI remains → daemon holds.
    await new Promise((r) => setTimeout(r, GRACE_MS + 150))
    expect(existsSync(h.socketPath)).toBe(true)

    b.close()
    // Now zero → self-stop.
    expect(await waitFor(() => !existsSync(h.socketPath), GRACE_MS + 500)).toBe(true)
  })

  it("a re-subscribe within the grace window cancels the pending shutdown", async () => {
    h = await boot()
    const first = h.client()
    await first.subscribe({ role: "gui" })
    first.close() // arms the grace timer

    // Reconnect before grace elapses (mirrors manualReconnect's force-drop).
    const second = h.client()
    await second.subscribe({ role: "gui" })

    await new Promise((r) => setTimeout(r, GRACE_MS + 150))
    expect(existsSync(h.socketPath)).toBe(true)
    second.close()
  })
})
