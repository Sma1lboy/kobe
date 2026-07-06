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
