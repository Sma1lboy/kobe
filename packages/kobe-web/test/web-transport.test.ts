import { describe, expect, it } from "vitest"
import {
  isWebTransportConnected,
  isWebTransportOffline,
  shouldShowDaemonOfflineBanner,
  webTransportStatus,
  webTransportTopBarView,
} from "../src/lib/web-transport.ts"

describe("web transport connectivity", () => {
  it("treats connected SSE plus connected daemon as online", () => {
    const c = { daemonConnected: true, streamConnected: true }
    expect(webTransportStatus(c)).toBe("connected")
    expect(isWebTransportConnected(c)).toBe(true)
    expect(isWebTransportOffline(c)).toBe(false)
  })

  it("distinguishes daemon outage from EventSource outage", () => {
    expect(
      webTransportStatus({ daemonConnected: false, streamConnected: true }),
    ).toBe("daemon-offline")
    expect(
      webTransportStatus({ daemonConnected: true, streamConnected: false }),
    ).toBe("event-stream-disconnected")
  })

  it("shows the daemon banner only after hydration with a live stream", () => {
    expect(
      shouldShowDaemonOfflineBanner({
        hydrated: true,
        daemonConnected: false,
        streamConnected: true,
      }),
    ).toBe(true)
    expect(
      shouldShowDaemonOfflineBanner({
        hydrated: false,
        daemonConnected: false,
        streamConnected: true,
      }),
    ).toBe(false)
    expect(
      shouldShowDaemonOfflineBanner({
        hydrated: true,
        daemonConnected: false,
        streamConnected: false,
      }),
    ).toBe(false)
  })

  it("keeps topbar labels in one policy module", () => {
    expect(
      webTransportTopBarView({
        daemonConnected: true,
        streamConnected: true,
      }),
    ).toEqual({ ok: true, label: "daemon connected" })
    expect(
      webTransportTopBarView({
        daemonConnected: false,
        streamConnected: true,
      }),
    ).toMatchObject({ ok: false, label: "no daemon" })
    expect(
      webTransportTopBarView({
        daemonConnected: false,
        streamConnected: false,
      }),
    ).toEqual({ ok: false, label: "connecting…" })
  })
})
