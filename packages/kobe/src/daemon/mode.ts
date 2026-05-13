export type TuiDaemonMode = "single" | "shared"

export function resolveDaemonMode(flagMode: TuiDaemonMode | undefined, env = process.env): TuiDaemonMode {
  if (flagMode) return flagMode
  return env.KOBE_DAEMON_MODE === "shared" ? "shared" : "single"
}
