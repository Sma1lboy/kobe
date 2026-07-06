/**
 * Payload validators — the shared vocabulary every daemon RPC handler
 * validates with. Promoted verbatim from `handlers.ts` (itself promoted
 * verbatim from `server.ts`'s pre-registry switch); the error wording
 * (`"${key} is required"`, `"${key} must be a string"`, …) is part of the
 * wire contract, so don't reword it.
 *
 * Split into its own module (rather than living in `handlers.ts`) so
 * `handlers-task.ts`/`handlers-worktree.ts` can import these without a
 * circular import back into `handlers.ts`, which imports THEM.
 */

import type { EngineActivityDetail } from "@/engine/hook-events"
import type { VendorId } from "@/types/task"

/** Coerce an unknown request payload into a plain object (`{}` for anything else). */
export function objectPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {}
  return payload as Record<string, unknown>
}

export function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`)
  return value
}

export function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value
}

export function optionalBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`)
  return value
}

export function optionalVendor(payload: Record<string, unknown>, key: string): VendorId | undefined {
  // Engines are open: a vendor id may be a built-in OR a user-registered
  // custom engine (its launch command lives in the kobe-side customEngineIds
  // registry, which the daemon can't see). So accept any non-empty string and
  // let the launch path resolve it — a bogus id just fails to launch its
  // (missing) binary in the pane. Empty/absent stays undefined (→ claude).
  const value = optionalString(payload, key)
  return value && value.trim().length > 0 ? (value as VendorId) : undefined
}

/** Coerce the optional `detail` of an `engine.reportEvent` payload, dropping
 *  anything malformed (the field is best-effort UI hint, never load-bearing). */
export function optionalActivityDetail(payload: Record<string, unknown>): EngineActivityDetail | undefined {
  const raw = payload.detail
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const d = raw as Record<string, unknown>
  const out: { failure?: "rate_limit" | "billing" | "other"; waiting?: "permission" | "input"; note?: string } = {}
  if (d.failure === "rate_limit" || d.failure === "billing" || d.failure === "other") out.failure = d.failure
  if (d.waiting === "permission" || d.waiting === "input") out.waiting = d.waiting
  if (typeof d.note === "string") out.note = d.note
  return Object.keys(out).length > 0 ? out : undefined
}
