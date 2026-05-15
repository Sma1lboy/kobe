/**
 * Wire-payload validators shared by every daemon handler.
 *
 * Each helper throws a human-readable Error when validation fails; the
 * caller in `handleRequest` catches and turns it into a `response`
 * frame with an `error` field. The taxonomy is intentionally tiny —
 * `requireX` (throws when absent/wrong-type) and `optionalX` (returns
 * undefined when absent, throws when present-but-wrong-type).
 */

import type { ModelEffortLevel, UserInputResponse } from "../types/engine.ts"
import type { VendorId } from "../types/task.ts"

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

export function optionalModelEffort(payload: Record<string, unknown>, key: string): ModelEffortLevel | undefined {
  const value = optionalString(payload, key)
  if (
    value !== undefined &&
    value !== "none" &&
    value !== "minimal" &&
    value !== "low" &&
    value !== "medium" &&
    value !== "high" &&
    value !== "xhigh" &&
    value !== "max"
  ) {
    throw new Error(`${key} must be a supported effort level`)
  }
  return value
}

export function optionalVendor(payload: Record<string, unknown>, key: string): VendorId | undefined {
  const value = optionalString(payload, key)
  if (value !== undefined && value !== "claude" && value !== "codex") {
    throw new Error(`${key} must be a supported vendor`)
  }
  return value
}

export function optionalBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`)
  return value
}

export function optionalNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number`)
  return value
}

export function normalizeTaskIds(value: unknown): "all" | string[] {
  if (value === undefined || value === null || value === "all") return "all"
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value
  throw new Error("taskIds must be 'all' or string[]")
}

export function requireUserInputResponse(value: unknown): UserInputResponse {
  if (!value || typeof value !== "object") throw new Error("response is required")
  const obj = value as Record<string, unknown>
  if (obj.kind === "approve_plan") {
    if (typeof obj.approve !== "boolean") throw new Error("response.approve must be a boolean")
    return { kind: "approve_plan", approve: obj.approve }
  }
  if (obj.kind === "ask_question") {
    if (!obj.answers || typeof obj.answers !== "object" || Array.isArray(obj.answers)) {
      throw new Error("response.answers must be an object")
    }
    const answers: Record<string, string> = {}
    for (const [key, answer] of Object.entries(obj.answers)) {
      if (typeof answer === "string") answers[key] = answer
    }
    return { kind: "ask_question", answers }
  }
  throw new Error("response.kind must be approve_plan or ask_question")
}
