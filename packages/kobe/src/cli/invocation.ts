/**
 * How to re-invoke the kobe CLI as a subprocess.
 *
 * Some features spawn a kobe subcommand in a child process (the Ops
 * pane runs `kobe ops` inside a tmux pane; a future full-width preview
 * window will too). In a packaged install that's just `kobe` on PATH;
 * in dev (`bun run dev`) there's no `kobe` bin, so we reconstruct the
 * exact runtime the dev script uses.
 *
 * Lives in `cli/` (not `tmux/`) because it's about the kobe binary,
 * not tmux — tmux is just one caller.
 */

import { fileURLToPath } from "node:url"

/**
 * argv prefix that runs the kobe CLI. Append the subcommand + flags:
 *
 *   [...kobeCliInvocation(), "ops", "--worktree", wt]
 *
 * Packaged build → `["kobe"]` (npm bin shim on PATH). Dev → `[<bun>,
 * "--preload", <abs opentui preload>, "--conditions=browser",
 * <cli entry>]`.
 *
 * Why the dev branch is fiddly: a child kobe must boot opentui/solid
 * the way the dev script does (JSX preload + the `browser` export
 * condition) or it crashes with "Export named 'jsxDEV' not found".
 * The preload must be an ABSOLUTE path — a spawned subcommand may run
 * with an arbitrary cwd (e.g. the Ops pane's cwd is the worktree,
 * whose node_modules has no opentui), so a bare `@opentui/solid/preload`
 * specifier wouldn't resolve. `import.meta.resolve` resolves against
 * THIS module (inside the kobe package), so it always finds kobe's
 * own copy. (Bug history: KOB-233.)
 */
export function kobeCliInvocation(): string[] {
  const isBuilt = import.meta.url.endsWith(".js")
  if (isBuilt) return ["kobe"]
  const entry = fileURLToPath(new URL("./index.ts", import.meta.url))
  const preload = fileURLToPath(import.meta.resolve("@opentui/solid/preload"))
  return [process.execPath, "--preload", preload, "--conditions=browser", entry]
}
