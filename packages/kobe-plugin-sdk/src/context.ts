/**
 * Parse the KOBE_PLUGIN_* environment the host injects into every plugin
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
  /** Exec this to call back into kobe. */
  readonly binPath: string
  /** Daemon unix socket for raw JSON frames. */
  readonly socketPath: string
  /** Set when kobe runs against a non-default home; pass it through. */
  readonly homeDir?: string
  /** Entrypoint-specific fields (absent outside that entrypoint kind). */
  readonly event?: string
  readonly taskId?: string
  readonly taskTitle?: string
  readonly actionId?: string
  readonly invokeCwd?: string
  readonly entrypointId?: string
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (!value) throw new Error(`${key} is not set — is this process running as a kobe plugin command?`)
  return value
}

/** Read the plugin context from the environment. Throws off-host. */
export function pluginContext(env: NodeJS.ProcessEnv = process.env): PluginContext {
  return {
    pluginId: required(env, "KOBE_PLUGIN_ID"),
    pluginRoot: required(env, "KOBE_PLUGIN_ROOT"),
    configDir: required(env, "KOBE_PLUGIN_CONFIG_DIR"),
    stateDir: required(env, "KOBE_PLUGIN_STATE_DIR"),
    binPath: required(env, "KOBE_BIN_PATH"),
    socketPath: required(env, "KOBE_SOCKET_PATH"),
    homeDir: env.KOBE_HOME_DIR,
    event: env.KOBE_PLUGIN_EVENT,
    taskId: env.KOBE_PLUGIN_TASK_ID,
    taskTitle: env.KOBE_PLUGIN_TASK_TITLE,
    actionId: env.KOBE_PLUGIN_ACTION_ID,
    invokeCwd: env.KOBE_PLUGIN_INVOKE_CWD,
    entrypointId: env.KOBE_PLUGIN_ENTRYPOINT_ID,
  }
}

/**
 * The fired event's envelope, parsed from `KOBE_PLUGIN_EVENT_JSON`.
 * Returns null outside an `[[events]]` entrypoint.
 */
export function pluginEvent(env: NodeJS.ProcessEnv = process.env): PluginEventEnvelope | null {
  const raw = env.KOBE_PLUGIN_EVENT_JSON
  if (!raw) return null
  return JSON.parse(raw) as PluginEventEnvelope
}
