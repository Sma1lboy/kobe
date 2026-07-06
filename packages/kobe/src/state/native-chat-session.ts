/**
 * Native-chat provider session parking.
 *
 * This is runtime state, not a user setting: it stores the opaque harness
 * resume payload returned by `HarnessAgentSession.stop()` so a later Kobe
 * process can call `agent.createSession({ sessionId, resumeFrom })`.
 */

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { HarnessAgentResumeSessionState } from "@ai-sdk/harness/agent"
import { kobeStateDir } from "../env"

export type NativeChatSessionVendor = "claude" | "codex"
export type NativeChatSessionPurpose = "chat" | "router"

export interface NativeChatSessionRef {
  readonly vendor: NativeChatSessionVendor
  readonly purpose: NativeChatSessionPurpose
  readonly worktree: string
}

export interface NativeChatSessionRecord extends NativeChatSessionRef {
  readonly version: 1
  readonly sessionId: string
  readonly resumeState: HarnessAgentResumeSessionState
  readonly model?: string
  readonly modelEffort?: string
  readonly updatedAt: string
}

interface NativeChatSessionFile {
  readonly version: 1
  readonly sessions: Record<string, NativeChatSessionRecord>
}

export function nativeChatSessionStorePath(): string {
  return join(kobeStateDir(), "native-chat-sessions.json")
}

export function nativeChatSessionKey(ref: NativeChatSessionRef): string {
  const hash = createHash("sha1").update(ref.worktree).digest("hex").slice(0, 16)
  return `${ref.purpose}:${ref.vendor}:${hash}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isResumeState(value: unknown): value is HarnessAgentResumeSessionState {
  if (!isObject(value)) return false
  return (
    value.type === "resume-session" &&
    typeof value.harnessId === "string" &&
    value.specificationVersion === "harness-v1" &&
    "data" in value
  )
}

function parseRecord(value: unknown): NativeChatSessionRecord | undefined {
  if (!isObject(value)) return undefined
  if (value.version !== 1) return undefined
  if (value.vendor !== "claude" && value.vendor !== "codex") return undefined
  if (value.purpose !== "chat" && value.purpose !== "router") return undefined
  if (typeof value.worktree !== "string" || typeof value.sessionId !== "string") return undefined
  if (typeof value.updatedAt !== "string" || !isResumeState(value.resumeState)) return undefined
  const model = typeof value.model === "string" ? value.model : undefined
  const modelEffort = typeof value.modelEffort === "string" ? value.modelEffort : undefined
  return {
    version: 1,
    vendor: value.vendor,
    purpose: value.purpose,
    worktree: value.worktree,
    sessionId: value.sessionId,
    resumeState: value.resumeState,
    ...(model ? { model } : {}),
    ...(modelEffort ? { modelEffort } : {}),
    updatedAt: value.updatedAt,
  }
}

function loadSessionFile(): NativeChatSessionFile {
  try {
    const parsed = JSON.parse(readFileSync(nativeChatSessionStorePath(), "utf8")) as unknown
    if (!isObject(parsed) || !isObject(parsed.sessions)) return { version: 1, sessions: {} }
    const sessions: Record<string, NativeChatSessionRecord> = {}
    for (const [key, value] of Object.entries(parsed.sessions)) {
      const record = parseRecord(value)
      if (record) sessions[key] = record
    }
    return { version: 1, sessions }
  } catch {
    return { version: 1, sessions: {} }
  }
}

function writeSessionFile(file: NativeChatSessionFile): void {
  const path = nativeChatSessionStorePath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2), "utf8")
  renameSync(tmp, path)
}

export function readNativeChatSession(ref: NativeChatSessionRef): NativeChatSessionRecord | undefined {
  return loadSessionFile().sessions[nativeChatSessionKey(ref)]
}

export function writeNativeChatSession(record: NativeChatSessionRecord): void {
  const file = loadSessionFile()
  file.sessions[nativeChatSessionKey(record)] = record
  writeSessionFile(file)
}

export function clearNativeChatSession(ref: NativeChatSessionRef): void {
  const file = loadSessionFile()
  delete file.sessions[nativeChatSessionKey(ref)]
  writeSessionFile(file)
}
