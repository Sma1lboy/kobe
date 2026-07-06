/**
 * Native chat model-router toggle. The router is opt-in because it spends an
 * extra same-provider small-model turn before each prompt.
 */

import { getPersistedBool } from "./store.ts"

export const NATIVE_CHAT_AUTO_MODEL_KEY = "experimental.nativeChatAutoModel"

export function nativeChatAutoModelEnabled(): boolean {
  return getPersistedBool(NATIVE_CHAT_AUTO_MODEL_KEY, false)
}
