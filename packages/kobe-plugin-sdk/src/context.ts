/**
 * Parse the ROVE_PLUGIN_* environment the host injects into every plugin
 * command (see docs/PLUGIN-AUTHORING.md § Environment contract). Pure env
 * reads — safe to call from any entrypoint kind.
 */

import type { PluginEventEnvelope } from "./contract.ts"

export interface PluginContext {
  /** Who you are and where your files live. */
  readonly pluginId: string
  readonly pluginRoot: string
  /** User-editable config dir (survives reinstall) — `.env` lives here. */
  readonly configDir: string
  /** Your durable state dir (survives reinstall). */
  readonly stateDir: string
  /** Exec this to call back into Rove. */
  readonly binPath: string
  /** Daemon unix socket for raw JSON frames. */
  readonly socketPath: string
  /** Set when Rove runs against a non-default home; pass it through. */
  readonly homeDir?: string
  /** Entrypoint-specific fields (absent outside that entrypoint kind). */
  readonly event?: string
  readonly taskId?: string
  readonly taskTitle?: string
  readonly actionId?: string
  readonly invokeCwd?: string
  readonly entrypointId?: string
}

function readCompat(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  return env[`ROVE_${suffix}`] ?? env[`KOBE_${suffix}`]
}

function required(env: NodeJS.ProcessEnv, suffix: string): string {
  const value = readCompat(env, suffix)
  if (!value) throw new Error(`ROVE_${suffix} is not set — is this process running as a Rove plugin command?`)
  return value
}

/** Read the plugin context from the environment. Throws off-host. */
export function pluginContext(env: NodeJS.ProcessEnv = process.env): PluginContext {
  return {
    pluginId: required(env, "PLUGIN_ID"),
    pluginRoot: required(env, "PLUGIN_ROOT"),
    configDir: required(env, "PLUGIN_CONFIG_DIR"),
    stateDir: required(env, "PLUGIN_STATE_DIR"),
    binPath: required(env, "BIN_PATH"),
    socketPath: required(env, "SOCKET_PATH"),
    homeDir: readCompat(env, "HOME_DIR"),
    event: readCompat(env, "PLUGIN_EVENT"),
    taskId: readCompat(env, "PLUGIN_TASK_ID"),
    taskTitle: readCompat(env, "PLUGIN_TASK_TITLE"),
    actionId: readCompat(env, "PLUGIN_ACTION_ID"),
    invokeCwd: readCompat(env, "PLUGIN_INVOKE_CWD"),
    entrypointId: readCompat(env, "PLUGIN_ENTRYPOINT_ID"),
  }
}

/**
 * The fired event's envelope, parsed from `ROVE_PLUGIN_EVENT_JSON` (or its
 * legacy `KOBE_` alias).
 * Returns null outside an `[[events]]` entrypoint.
 */
export function pluginEvent(env: NodeJS.ProcessEnv = process.env): PluginEventEnvelope | null {
  const raw = readCompat(env, "PLUGIN_EVENT_JSON")
  if (!raw) return null
  return JSON.parse(raw) as PluginEventEnvelope
}
