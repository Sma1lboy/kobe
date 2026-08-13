import { installRoveEnvCompatibility } from "@sma1lboy/kobe-daemon/compat-env"
import { LEGACY_KOBE_PRODUCT_NAME, type ProductCliName, ROVE_PRODUCT_NAME } from "../product.ts"

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

export function activeCliName(env: NodeJS.ProcessEnv = process.env): ProductCliName {
  return env[INVOKED_AS_ENV] === ROVE_PRODUCT_NAME ? ROVE_PRODUCT_NAME : LEGACY_KOBE_PRODUCT_NAME
}
