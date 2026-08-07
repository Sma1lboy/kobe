export interface DaemonWebStatus {
  socketPath?: unknown
  webPort?: unknown
  webError?: unknown
}

/**
 * Bind the dev proxy to the HTTP transport owned by the daemon reached over
 * the selected socket. A fixed/default port is not an identity: a different
 * production or sandbox daemon can legitimately be listening there.
 */
export function daemonWebPortFromStatus(status: DaemonWebStatus, expectedSocketPath: string): string {
  if (status.socketPath !== expectedSocketPath) {
    throw new Error(
      `daemon identity mismatch: connected to ${expectedSocketPath}, status reported ${String(status.socketPath)}`,
    )
  }
  if (
    typeof status.webPort !== "number" ||
    !Number.isInteger(status.webPort) ||
    status.webPort < 1 ||
    status.webPort > 65_535
  ) {
    const reason = typeof status.webError === "string" && status.webError ? ` (${status.webError})` : ""
    throw new Error(`selected daemon has no reachable web transport${reason}`)
  }
  return String(status.webPort)
}
