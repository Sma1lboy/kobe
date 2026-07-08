/**
 * Framework-free host-boot pieces shared by the Solid pane host
 * (`./host-boot.tsx`) and the React one (`src/tui-react/lib/host-boot.tsx`,
 * issue #15 G3). Extracted so the render-option contract and the
 * exit-signal backstop cannot drift between the two boot paths.
 */

/**
 * The render-option set shared by every host: transparent background (the
 * terminal's own bg shows through), passthrough external output, no
 * exit-on-Ctrl+C (hosts own their quit semantics), alternate screen, kitty
 * keyboard protocol. `onDestroy` is the only delta any host ever had; it's
 * spread in only when present so a host without teardown passes the exact
 * same shape as before.
 */
export function hostRenderOptions(onDestroy?: () => void): Record<string, unknown> {
  const base = {
    backgroundColor: "transparent",
    externalOutputMode: "passthrough",
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    useKittyKeyboard: {},
  }
  return onDestroy ? { ...base, onDestroy } : base
}

/**
 * Exit-signal backstop (orphaned-helper leak): opentui's own exit handler
 * for SIGHUP/SIGTERM only destroys the renderer — it never calls
 * process.exit — and installing that listener replaced the signals' default
 * "terminate" action. A host keeps its event loop alive (daemon socket,
 * file watcher, poll timers), so every tmux `kill-pane` / `respawn-pane -k`
 * / session teardown would leave the process running forever with a revoked
 * tty, reparented to launchd. Register AFTER render resolves so opentui's
 * handler (terminal restore + onDestroy) runs first.
 *
 * The exit is DELAYED, not immediate: some flows kill the session their own
 * pane lives in and then keep orchestrating (togglePreview's
 * kill→rebuild→switch, ensureSession's vendor-switch rebuild) — an instant
 * exit on the incoming SIGHUP would truncate them. Five seconds is enough
 * for any in-flight tmux sequence; the pane is already gone from the
 * screen, so the tail is invisible.
 */
export function installPaneExitBackstop(): void {
  let exitScheduled = false
  const scheduleExit = () => {
    if (exitScheduled) return
    exitScheduled = true
    setTimeout(() => process.exit(0), 5000)
  }
  for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) {
    process.on(signal, scheduleExit)
  }
}

/**
 * Orphan watchdog (issue #25) — the signal-FREE half of the leak defense.
 * The signal backstop above only fires when a signal actually arrives; when
 * the parent chain is SIGKILLed (2026-07-07: OOM killed the tmux server and
 * 41 pane hosts survived reparented to init, ~8.7GB RSS, which then fed the
 * next OOM), nothing is delivered and the host lives forever with a revoked
 * tty. A host's parent is always its tmux pane shell or the user's shell,
 * so PPID 1 can only mean "my pane/terminal is gone" — exit.
 *
 * Poll, don't listen: there is no parent-death event on macOS for an
 * already-running child. 5s cadence on a 0-work check is free.
 */
export function installOrphanExitWatchdog(intervalMs = 5000): () => void {
  const timer = setInterval(() => {
    if (process.ppid === 1) process.exit(0)
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
