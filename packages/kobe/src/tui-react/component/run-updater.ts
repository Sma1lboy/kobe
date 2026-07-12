/**
 * Shared "leave the TUI and run the shell updater" tail used by the update
 * page (latest) and the versions page (pinned): destroy the renderer, run
 * the GitHub-hosted update script inheriting the terminal, report, wait
 * for a key, and exit the process. The self-replace exit is deliberate —
 * no in-process surface can survive its own binary being swapped.
 */

import { spawnSync } from "node:child_process"
import { CURRENT_VERSION } from "../../version.ts"

type UpdaterT = (key: string, params?: Record<string, string>) => string

export function waitForKeypress(): Promise<void> {
  if (!process.stdin.isTTY) return Promise.resolve()
  return new Promise((resolve) => {
    const stdin = process.stdin
    const done = () => {
      stdin.off("data", done)
      stdin.setRawMode?.(false)
      stdin.pause()
      resolve()
    }
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.once("data", done)
  })
}

export async function runShellUpdater(opts: {
  renderer: { destroy(): void } | null
  t: UpdaterT
  /** What the header shows after the arrow: "latest" or a pinned version. */
  targetLabel: string
  /** Full shell command to run (UPDATE_COMMAND, optionally `-s -- <v>`). */
  command: string
}): Promise<never> {
  opts.renderer?.destroy()
  process.stdout.write(`\nkobe ${CURRENT_VERSION} -> ${opts.targetLabel}\n`)
  process.stdout.write(`running: ${opts.command}\n\n`)
  const result = spawnSync("sh", ["-c", opts.command], { stdio: "inherit" })
  const code = result.status ?? (result.error ? 1 : 0)
  if (result.error) process.stderr.write(`\nkobe update: failed to start updater: ${result.error.message}\n`)
  process.stdout.write(
    code === 0
      ? `\n${opts.t("update.updateComplete")}\n`
      : `\n${opts.t("update.updateFailed", { code: String(code) })}\n`,
  )
  process.stdout.write(opts.t("update.pressAnyKey"))
  await waitForKeypress()
  process.exit(code)
}
