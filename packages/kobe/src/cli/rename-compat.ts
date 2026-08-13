import { installRoveEnvCompatibility } from "@sma1lboy/kobe-daemon/compat-env"
import { LEGACY_KOBE_PRODUCT_NAME, type ProductCliName, ROVE_PRODUCT_NAME } from "../product.ts"
import { migrateRoveClientStateLayout } from "../state/layout-migration.ts"

const INVOKED_AS_ENV = "ROVE_INVOKED_AS"

/** Mark the wrapper entry before loading the shared CLI implementation. */
export function markRoveInvocation(env: NodeJS.ProcessEnv = process.env): void {
  env[INVOKED_AS_ENV] = ROVE_PRODUCT_NAME
}

/** Keep the legacy wrapper identity explicit even if its environment was reused. */
export function markKobeInvocation(env: NodeJS.ProcessEnv = process.env): void {
  env[INVOKED_AS_ENV] = LEGACY_KOBE_PRODUCT_NAME
}

/** Install ROVE_* precedence before any runtime subsystem starts. */
export function prepareCliEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  installRoveEnvCompatibility(env)
}

/** Run the additive on-disk migration after environment precedence is installed. */
export function prepareCliStateLayout(env: NodeJS.ProcessEnv = process.env): void {
  const result = migrateRoveClientStateLayout(env)
  for (const warning of result.warnings) console.error(`[rove] state migration will retry: ${warning}`)
}

export function activeCliName(env: NodeJS.ProcessEnv = process.env): ProductCliName {
  return env[INVOKED_AS_ENV] === ROVE_PRODUCT_NAME ? ROVE_PRODUCT_NAME : LEGACY_KOBE_PRODUCT_NAME
}
