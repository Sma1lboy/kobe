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
import { LEGACY_KOBE_PRODUCT_NAME, ROVE_PRODUCT_NAME } from "../product.ts"
import { activeCliName } from "./rename-compat.ts"

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
export function roveCliInvocation(): string[] {
  const cliName = activeCliName()
  const isBuilt = import.meta.url.endsWith(".js")
  if (isBuilt) return [cliName]
  const entryName = cliName === ROVE_PRODUCT_NAME ? "rove.ts" : "kobe.ts"
  const entry = fileURLToPath(new URL(`./${entryName}`, import.meta.url))
  return [process.execPath, "--conditions=browser", entry]
}

/** @deprecated Internal compatibility alias; use {@link roveCliInvocation}. */
export const kobeCliInvocation = roveCliInvocation

/**
 * argv prefix for commands PERSISTED into global config (engine hook files in
 * `~/.claude` / `~/.codex`). Unlike {@link kobeCliInvocation}, a persisted
 * command outlives this process — a dev-run absolute entry path (often inside
 * a task worktree) goes stale the moment that worktree is removed, and every
 * hook fire then fails with "Module not found". So prefer the packaged `kobe`
 * on PATH even in dev; fall back to the dev invocation only when no packaged
 * bin exists.
 */
export function kobeHookInvocation(): string[] {
  if (import.meta.url.endsWith(".js")) return [LEGACY_KOBE_PRODUCT_NAME]
  if (Bun.which(LEGACY_KOBE_PRODUCT_NAME)) return [LEGACY_KOBE_PRODUCT_NAME]
  return roveCliInvocation()
}
