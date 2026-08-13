/** Stable names used while the product moves from kobe to rove. */
import {
  COMPAT_CONFIG_DIR_BASENAME,
  COMPAT_STATE_DIR_BASENAME,
  LEGACY_KOBE_PRODUCT_NAME,
  ROVE_PRODUCT_NAME,
} from "@sma1lboy/kobe-daemon/compat-env"

export { COMPAT_CONFIG_DIR_BASENAME, COMPAT_STATE_DIR_BASENAME, LEGACY_KOBE_PRODUCT_NAME, ROVE_PRODUCT_NAME }

export type ProductCliName = typeof ROVE_PRODUCT_NAME | typeof LEGACY_KOBE_PRODUCT_NAME

/** Canonical product identity. Compatibility surfaces may still use kobe. */
export const PRODUCT_NAME = ROVE_PRODUCT_NAME
export const PRODUCT_DISPLAY_NAME = "Rove" as const
