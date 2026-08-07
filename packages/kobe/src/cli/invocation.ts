/**
 * How to re-invoke the kobe CLI as a subprocess.
 *
 * Some features spawn a kobe subcommand in a child process. In a packaged
 * install that's just `kobe` on PATH;
 * in dev (`bun run dev`) there's no `kobe` bin, so we reconstruct the
 * exact runtime the dev script uses.
 *
 * Lives in `cli/` because it is about locating the kobe binary.
 */

import { fileURLToPath } from "node:url"

/**
 * argv prefix that runs the kobe CLI. Append the subcommand + flags:
 *
 *   [...kobeCliInvocation(), "ops", "--worktree", wt]
 *
 * Packaged build → `["kobe"]` (npm bin shim on PATH). Dev → `[<bun>,
 * "--conditions=browser", <cli entry>]`.
 *
 * The `browser` export condition is required — opentui resolves a
 * browser-conditioned entry, and the build (`scripts/build.ts`) passes the
 * same. The React JSX pragmas (`@jsxImportSource @opentui/react`) are honoured
 * by Bun's default transpiler, so no preload is needed.
 */
export function kobeCliInvocation(): string[] {
  const isBuilt = import.meta.url.endsWith(".js")
  if (isBuilt) return ["kobe"]
  const entry = fileURLToPath(new URL("./index.ts", import.meta.url))
  return [process.execPath, "--conditions=browser", entry]
}

/**
 * argv prefix for commands PERSISTED into global config (engine hook files in
 * `~/.claude` / `~/.codex`). A source/dev absolute path cannot be persisted:
 * it may point into a short-lived worktree. Instead the persisted dispatcher
 * chooses the current source reporter only when a Kobe-launched engine exports
 * {@link kobeHookReporterEnv}; every other process falls back to `kobe` on
 * PATH. Packaged builds need no dispatcher.
 */
export function kobeHookInvocation(): string[] {
  if (import.meta.url.endsWith(".js")) return ["kobe"]
  return [
    "sh",
    "-c",
    'if [ -n "${KOBE_DEV_CLI_ENTRY:-}" ] && [ -f "$KOBE_DEV_CLI_ENTRY" ] && [ -n "${KOBE_DEV_BUN:-}" ]; then exec "$KOBE_DEV_BUN" --conditions=browser "$KOBE_DEV_CLI_ENTRY" "$@"; fi; exec kobe "$@"',
    "kobe-hook",
  ]
}

/** Environment inherited by engine hook subprocesses in source/dev runs. */
export function kobeHookReporterEnv(): Readonly<Record<string, string>> {
  if (import.meta.url.endsWith(".js")) return {}
  return {
    KOBE_DEV_BUN: process.execPath,
    KOBE_DEV_CLI_ENTRY: fileURLToPath(new URL("./index.ts", import.meta.url)),
  }
}
