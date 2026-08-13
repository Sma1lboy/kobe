/**
 * Environment compatibility for the staged kobe -> rove rename.
 *
 * Runtime code still reads the established KOBE_* names internally. The
 * public CLI boundary mirrors every ROVE_* value onto its KOBE_* counterpart
 * before starting the daemon, PTY host, TUI, or a child CLI. Keeping the
 * translation here gives every process the same precedence rule:
 *
 *   ROVE_* > KOBE_*
 *
 * The state layout deliberately does not change in this phase.
 */

export const ROVE_ENV_PREFIX = "ROVE_"
export const LEGACY_KOBE_ENV_PREFIX = "KOBE_"
export const ROVE_PRODUCT_NAME = "rove" as const
export const LEGACY_KOBE_PRODUCT_NAME = "kobe" as const

/** Phase-one data layout: the executable changes, persisted paths do not. */
export const COMPAT_STATE_DIR_BASENAME = ".kobe" as const
export const COMPAT_CONFIG_DIR_BASENAME = "kobe" as const

export function legacyKobeEnvKey(roveKey: string): string | undefined {
  if (!roveKey.startsWith(ROVE_ENV_PREFIX)) return undefined
  return `${LEGACY_KOBE_ENV_PREFIX}${roveKey.slice(ROVE_ENV_PREFIX.length)}`
}

/** Read one renamed variable without mutating the supplied environment. */
export function readRoveEnv(suffix: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`${ROVE_ENV_PREFIX}${suffix}`] ?? env[`${LEGACY_KOBE_ENV_PREFIX}${suffix}`]
}

/**
 * Set an explicit control in both namespaces.
 *
 * Internal launchers use this when an isolation or command-line override must
 * beat every inherited value. Writing only KOBE_* is insufficient because a
 * child wrapper will correctly reapply ROVE_* precedence when it starts.
 */
export function setRoveEnv(suffix: string, value: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  env[`${ROVE_ENV_PREFIX}${suffix}`] = value
  env[`${LEGACY_KOBE_ENV_PREFIX}${suffix}`] = value
  return env
}

/**
 * Mirror every public ROVE_* control into the legacy internal namespace.
 * Existing KOBE_* values remain when no new-name value was supplied.
 */
export function installRoveEnvCompatibility(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key === "ROVE_INVOKED_AS") continue
    const legacyKey = legacyKobeEnvKey(key)
    if (legacyKey) env[legacyKey] = value
  }
  return env
}
