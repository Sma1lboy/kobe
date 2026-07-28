/**
 * The env contract a plugin command runs with — shared by the daemon's
 * PluginHost (startup/event hooks) and the CLI's `kobe plugin action invoke`
 * so both surfaces inject the identical KOBE_PLUGIN_* set.
 */

import { pluginConfigDir, pluginStateDir } from "./plugin-paths.ts"

export interface PluginEnvOptions {
  readonly homeDir?: string
  readonly socketPath: string
  readonly binPath: string
  readonly pluginId: string
  readonly pluginRoot: string
  readonly extra?: Record<string, string>
}

export function buildPluginEnv(opts: PluginEnvOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(opts.homeDir ? { KOBE_HOME_DIR: opts.homeDir } : {}),
    KOBE_SOCKET_PATH: opts.socketPath,
    KOBE_BIN_PATH: opts.binPath,
    KOBE_PLUGIN_ID: opts.pluginId,
    KOBE_PLUGIN_ROOT: opts.pluginRoot,
    KOBE_PLUGIN_CONFIG_DIR: pluginConfigDir(opts.pluginId, opts.homeDir),
    KOBE_PLUGIN_STATE_DIR: pluginStateDir(opts.pluginId, opts.homeDir),
    ...opts.extra,
  }
}
