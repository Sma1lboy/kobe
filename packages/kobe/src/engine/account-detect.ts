import { homedir } from "node:os"
import path from "node:path"
import { getCustomEngineIds } from "@/state/repos"
import type { VendorId } from "@/types/vendor"
import { ClaudeBinaryNotFoundError, findClaudeBinary } from "./claude-code-local/binary"
import { CodexBinaryNotFoundError, findCodexBinary } from "./codex-local/binary"
import { CopilotBinaryNotFoundError, findCopilotBinary } from "./copilot-local/binary"
import { readTextFileSyncBounded } from "./file-bounds"

export type ClaudeAccount =
  | {
      kind: "oauth"
      email: string
      organization?: string
      displayName?: string
      billingType?: string
    }
  | { kind: "none" }

export type CodexAccount = { kind: "chatgpt"; email: string; plan?: string } | { kind: "apikey" } | { kind: "none" }

export type CopilotAccount =
  | { kind: "token"; source: "COPILOT_GITHUB_TOKEN" | "GH_TOKEN" | "GITHUB_TOKEN" }
  | { kind: "oauth" }
  | { kind: "none" }

export type BinaryStatus = { found: true; path: string } | { found: false; error: string }

export interface EngineAccountStatus<A> {
  binary: BinaryStatus
  account: A
  accountError?: string
}

export interface DetectDeps {
  readFile(path: string): string | null
  env(name: string): string | undefined
  home(): string
  findClaudeBinary(): Promise<string>
  findCodexBinary(): Promise<string>
  findCopilotBinary(): Promise<string>
}

const defaultDeps: DetectDeps = {
  readFile(p: string): string | null {
    return readTextFileSyncBounded(p)
  },
  env(name) {
    return process.env[name]
  },
  home() {
    return homedir()
  },
  findClaudeBinary() {
    return findClaudeBinary()
  },
  findCodexBinary() {
    return findCodexBinary()
  },
  findCopilotBinary() {
    return findCopilotBinary()
  },
}

export function claudeGlobalConfigPath(env: (k: string) => string | undefined, home: string): string {
  const override = env("CLAUDE_CONFIG_DIR")?.trim()
  if (override) return path.join(override, ".claude.json")
  return path.join(home, ".claude.json")
}

export function codexAuthPath(env: (k: string) => string | undefined, home: string): string {
  const override = env("CODEX_HOME")?.trim()
  const dir = override ?? path.join(home, ".codex")
  return path.join(dir, "auth.json")
}

export function copilotConfigPath(env: (k: string) => string | undefined, home: string): string {
  const override = env("COPILOT_HOME")?.trim()
  const dir = override ?? path.join(home, ".copilot")
  return path.join(dir, "config.json")
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".")
  if (parts.length !== 3) return null
  const payload = parts[1]
  if (!payload) return null
  const b64 = payload.replace(/-/g, "+").replace(/_/g, "/")
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4)
  try {
    const json = Buffer.from(padded, "base64").toString("utf8")
    const obj = JSON.parse(json)
    return typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function probeBinary(probe: () => Promise<string>): Promise<BinaryStatus> {
  try {
    const p = await probe()
    return { found: true, path: p }
  } catch (err) {
    if (
      err instanceof ClaudeBinaryNotFoundError ||
      err instanceof CodexBinaryNotFoundError ||
      err instanceof CopilotBinaryNotFoundError
    ) {
      return { found: false, error: "not found on PATH" }
    }
    return { found: false, error: err instanceof Error ? err.message : String(err) }
  }
}

let cachedDefaultVendors: Promise<readonly VendorId[]> | null = null

async function probeAvailableVendors(deps: DetectDeps): Promise<readonly VendorId[]> {
  const probes: ReadonlyArray<readonly [VendorId, () => Promise<string>]> = [
    ["claude", () => deps.findClaudeBinary()],
    ["codex", () => deps.findCodexBinary()],
    ["copilot", () => deps.findCopilotBinary()],
  ]
  const detected = await Promise.all(
    probes.map(async ([vendor, probe]) => ((await probeBinary(probe)).found ? vendor : null)),
  )
  return detected.filter((v): v is VendorId => v !== null)
}

export function detectAvailableVendors(deps: DetectDeps = defaultDeps): Promise<readonly VendorId[]> {
  if (deps !== defaultDeps) return probeAvailableVendors(deps)
  if (cachedDefaultVendors) return cachedDefaultVendors
  const pending = probeAvailableVendors(deps).catch((err) => {
    cachedDefaultVendors = null
    throw err
  })
  cachedDefaultVendors = pending
  return pending
}

export function resetAvailableVendorsCache(): void {
  cachedDefaultVendors = null
}

export async function availableEngineIds(deps: DetectDeps = defaultDeps): Promise<readonly VendorId[]> {
  const builtins = await detectAvailableVendors(deps)
  return [...builtins, ...getCustomEngineIds()]
}

export async function detectClaudeAccount(deps: DetectDeps = defaultDeps): Promise<EngineAccountStatus<ClaudeAccount>> {
  const binary = await probeBinary(() => deps.findClaudeBinary())
  const configPath = claudeGlobalConfigPath(deps.env, deps.home())
  let raw: string | null
  try {
    raw = deps.readFile(configPath)
  } catch (err) {
    return {
      binary,
      account: { kind: "none" },
      accountError: `read ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (raw === null) return { binary, account: { kind: "none" } }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      binary,
      account: { kind: "none" },
      accountError: `parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const oauth = (parsed as { oauthAccount?: unknown } | null)?.oauthAccount
  if (!oauth || typeof oauth !== "object") return { binary, account: { kind: "none" } }
  const o = oauth as Record<string, unknown>
  const email = typeof o.emailAddress === "string" ? o.emailAddress : undefined
  if (!email) return { binary, account: { kind: "none" } }
  return {
    binary,
    account: {
      kind: "oauth",
      email,
      organization: typeof o.organizationName === "string" ? o.organizationName : undefined,
      displayName: typeof o.displayName === "string" ? o.displayName : undefined,
      billingType: typeof o.billingType === "string" ? o.billingType : undefined,
    },
  }
}

export async function detectCodexAccount(deps: DetectDeps = defaultDeps): Promise<EngineAccountStatus<CodexAccount>> {
  const binary = await probeBinary(() => deps.findCodexBinary())
  const authPath = codexAuthPath(deps.env, deps.home())
  let raw: string | null
  try {
    raw = deps.readFile(authPath)
  } catch (err) {
    return {
      binary,
      account: { kind: "none" },
      accountError: `read ${authPath}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (raw === null) return { binary, account: { kind: "none" } }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      binary,
      account: { kind: "none" },
      accountError: `parse ${authPath}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const obj = (parsed ?? {}) as Record<string, unknown>
  const tokens = obj.tokens as { id_token?: unknown } | undefined
  const idToken = typeof tokens?.id_token === "string" ? tokens.id_token : undefined
  if (idToken) {
    const payload = decodeJwtPayload(idToken)
    if (!payload) {
      return {
        binary,
        account: { kind: "none" },
        accountError: "codex id_token: malformed JWT",
      }
    }
    const email = typeof payload.email === "string" ? payload.email : undefined
    const authClaimRaw = payload["https://api.openai.com/auth"]
    const authClaim =
      typeof authClaimRaw === "object" && authClaimRaw !== null && !Array.isArray(authClaimRaw)
        ? (authClaimRaw as Record<string, unknown>)
        : undefined
    const plan = typeof authClaim?.chatgpt_plan_type === "string" ? authClaim.chatgpt_plan_type : undefined
    if (email) return { binary, account: { kind: "chatgpt", email, plan } }
    return { binary, account: { kind: "none" }, accountError: "codex id_token: no email claim" }
  }
  const apiKey = obj.OPENAI_API_KEY
  if (typeof apiKey === "string" && apiKey.length > 0) {
    return { binary, account: { kind: "apikey" } }
  }
  return { binary, account: { kind: "none" } }
}

export async function detectCopilotAccount(
  deps: DetectDeps = defaultDeps,
): Promise<EngineAccountStatus<CopilotAccount>> {
  const binary = await probeBinary(() => deps.findCopilotBinary())
  for (const source of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const) {
    if (deps.env(source)?.trim()) return { binary, account: { kind: "token", source } }
  }

  const configPath = copilotConfigPath(deps.env, deps.home())
  let raw: string | null
  try {
    raw = deps.readFile(configPath)
  } catch (err) {
    return {
      binary,
      account: { kind: "none" },
      accountError: `read ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (raw === null) return { binary, account: { kind: "none" } }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      binary,
      account: { kind: "none" },
      accountError: `parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (!isRecord(parsed)) return { binary, account: { kind: "none" } }
  if (
    hasStringDeep(parsed, [
      "github_token",
      "oauth_token",
      "access_token",
      "token",
      "selectedUser",
      "currentUser",
      "user",
    ])
  ) {
    return { binary, account: { kind: "oauth" } }
  }
  return { binary, account: { kind: "none" } }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function hasStringDeep(value: unknown, interestingKeys: readonly string[], depth = 0): boolean {
  if (depth > 4 || !isRecord(value)) return false
  for (const [key, entry] of Object.entries(value)) {
    if (interestingKeys.includes(key) && typeof entry === "string" && entry.length > 0) return true
    if (isRecord(entry) && hasStringDeep(entry, interestingKeys, depth + 1)) return true
  }
  return false
}
