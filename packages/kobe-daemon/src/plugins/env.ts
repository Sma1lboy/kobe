/**
 * The env contract a plugin command runs with — shared by the daemon's
 * PluginHost (startup/event hooks) and the CLI's `kobe plugin action invoke`
 * so both surfaces inject identical ROVE_PLUGIN_* variables plus their
 * permanent KOBE_PLUGIN_* compatibility aliases.
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
  const configDir = pluginConfigDir(opts.pluginId, opts.homeDir)
  const stateDir = pluginStateDir(opts.pluginId, opts.homeDir)
  const extra = withPluginEnvAliases(opts.extra ?? {})
  return {
    ...process.env,
    ...(opts.homeDir ? { ROVE_HOME_DIR: opts.homeDir, KOBE_HOME_DIR: opts.homeDir } : {}),
    ROVE_SOCKET_PATH: opts.socketPath,
    KOBE_SOCKET_PATH: opts.socketPath,
    ROVE_BIN_PATH: opts.binPath,
    KOBE_BIN_PATH: opts.binPath,
    ROVE_PLUGIN_ID: opts.pluginId,
    KOBE_PLUGIN_ID: opts.pluginId,
    ROVE_PLUGIN_ROOT: opts.pluginRoot,
    KOBE_PLUGIN_ROOT: opts.pluginRoot,
    ROVE_PLUGIN_CONFIG_DIR: configDir,
    KOBE_PLUGIN_CONFIG_DIR: configDir,
    ROVE_PLUGIN_STATE_DIR: stateDir,
    KOBE_PLUGIN_STATE_DIR: stateDir,
    ...extra,
  }
}

/** Add the opposite namespace for entrypoint-specific variables. Callers
 * still pass their established KOBE_* keys; new ROVE_* keys work too. */
function withPluginEnvAliases(values: Record<string, string>): Record<string, string> {
  const aliases: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith("ROVE_")) aliases[`KOBE_${key.slice("ROVE_".length)}`] = value
    else if (key.startsWith("KOBE_")) aliases[`ROVE_${key.slice("KOBE_".length)}`] = value
  }
  return { ...aliases, ...values }
}
