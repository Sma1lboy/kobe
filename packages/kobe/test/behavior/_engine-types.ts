/**
 * Re-export shim for the canonical `AIEngine` types.
 *
 * Stream 0.4 originally declared a local mirror here while Stream 0.3 was
 * still in-flight. At G0 merge, this file became a thin re-export so the
 * single edit point promised by the original comment still holds —
 * downstream behavior tests import from `./_engine-types` and don't need
 * to change.
 *
 * If you're writing new code, import directly from `@/types/engine`.
 */

export type { AIEngine, EngineEvent, Message, SessionHandle, SpawnOpts } from "@/types/engine"
