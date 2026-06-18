export interface WebTransportConnectivity {
  daemonConnected: boolean
  streamConnected: boolean
  hydrated?: boolean
}

export type WebTransportStatus =
  | "connected"
  | "daemon-offline"
  | "event-stream-disconnected"

export function webTransportStatus({
  daemonConnected,
  streamConnected,
}: WebTransportConnectivity): WebTransportStatus {
  if (!streamConnected) return "event-stream-disconnected"
  return daemonConnected ? "connected" : "daemon-offline"
}

export function isWebTransportConnected(
  connectivity: WebTransportConnectivity,
): boolean {
  return webTransportStatus(connectivity) === "connected"
}

export function isWebTransportOffline(
  connectivity: WebTransportConnectivity,
): boolean {
  return !isWebTransportConnected(connectivity)
}

export function shouldShowDaemonOfflineBanner(
  connectivity: WebTransportConnectivity,
): boolean {
  return (
    Boolean(connectivity.hydrated) &&
    webTransportStatus(connectivity) === "daemon-offline"
  )
}

export function webTransportTopBarView(
  connectivity: WebTransportConnectivity,
): {
  ok: boolean
  label: string
  title?: string
} {
  const status = webTransportStatus(connectivity)
  if (status === "connected") return { ok: true, label: "daemon connected" }
  if (status === "daemon-offline") {
    return {
      ok: false,
      label: "no daemon",
      title:
        "Daemon offline — if it doesn't recover, run `kobe doctor` or `kobe reset` in a terminal.",
    }
  }
  return { ok: false, label: "connecting…" }
}
