/**
 * Pane launch composition — shared by `kobe plugin pane open` (CLI) and the
 * TUI's ctrl+e picker, so both build the IDENTICAL argv: one `sh -lc` script
 * carrying the plugin env contract, with `$ROVE_PLUGIN_ROOT` (or its legacy
 * Kobe alias) expanded in the
 * manifest command. The pane's PTY runs in the task worktree; no tab/PTY
 * schema knows about plugins (docs/design/plugins.md §Panes).
 */

import { buildPluginEnv } from "./env.ts"
import { type PluginPane, currentPluginPlatform, readPluginManifest, supportsPlatform } from "./manifest.ts"
import { loadPluginRegistry } from "./registry.ts"

export interface PaneLaunch {
  readonly pluginId: string
  readonly paneId: string
  readonly title: string
  readonly placement: "split" | "tab"
  readonly argv: readonly string[]
}

export interface PaneLaunchOpts {
  readonly homeDir?: string
  readonly socketPath: string
  readonly binPath: string
}

/** POSIX single-quote for embedding in an `sh -lc` script. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/** The `["sh", "-lc", …]` argv that runs one pane with the env contract. */
export function buildPaneArgv(
  pluginId: string,
  pluginRoot: string,
  pane: PluginPane,
  opts: PaneLaunchOpts,
): readonly string[] {
  const env = buildPluginEnv({
    homeDir: opts.homeDir,
    socketPath: opts.socketPath,
    binPath: opts.binPath,
    pluginId,
    pluginRoot,
    extra: { ROVE_PLUGIN_ENTRYPOINT_ID: pane.id },
  })
  const pairs = Object.entries(env).filter(([k]) => k.startsWith("ROVE_") || k.startsWith("KOBE_")) as [
    string,
    string,
  ][]
  const command = pane.command.map((a) => a.replace(/\$\{?(?:ROVE|KOBE)_PLUGIN_ROOT\}?/g, pluginRoot))
  const script = `exec env ${pairs.map(([k, v]) => shq(`${k}=${v}`)).join(" ")} ${command.map(shq).join(" ")}`
  return ["sh", "-lc", script]
}

/** Every pane of every ENABLED plugin that runs on this platform, launch-ready. */
export function listPaneLaunches(opts: PaneLaunchOpts): PaneLaunch[] {
  const platform = currentPluginPlatform()
  const out: PaneLaunch[] = []
  for (const entry of loadPluginRegistry(opts.homeDir).plugins) {
    if (!entry.enabled) continue
    try {
      const { manifest } = readPluginManifest(entry.root)
      if (!supportsPlatform({}, manifest, platform)) continue
      for (const pane of manifest.panes) {
        if (!supportsPlatform(pane, manifest, platform)) continue
        out.push({
          pluginId: entry.id,
          paneId: pane.id,
          title: pane.title,
          placement: pane.placement,
          argv: buildPaneArgv(entry.id, entry.root, pane, opts),
        })
      }
    } catch {
      // Unreadable manifest → the plugin simply contributes no panes.
    }
  }
  return out
}
