import { execSync } from "node:child_process"
import { resolve } from "node:path"

/**
 * Kill any tmux sessions the dev:sandbox TUI left on the sandbox socket so they
 * don't bleed into the next run (the tmux server persists across processes).
 * No-op for dev:mock (no tmux) — the reset just finds nothing to kill.
 */
export default function globalTeardown(): void {
  try {
    execSync("bun run dev:sandbox:reset", {
      cwd: resolve(import.meta.dirname, "../../kobe"),
      stdio: "ignore",
    })
  } catch {
    // Best-effort cleanup — never fail the run on teardown.
  }
}
