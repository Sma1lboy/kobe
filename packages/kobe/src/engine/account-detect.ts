/**
 * Read-only account detection for the engines kobe drives:
 * `claude` (Anthropic), `codex` (OpenAI), and `copilot` (GitHub).
 * (v0.6 dropped the `gemini` engine entirely — no interactive TUI worth
 * wrapping — so it's not detected here.)
 *
 * The settings dialog's "Accounts" section calls these to show "is
 * `claude` / `codex` / `copilot` installed?" and "is there a local account?".
 * Future work (codex sub-login flows etc.) layers on top — the read
 * path stays the same, only the action set grows.
 *
 * What we read (no writes, ever):
 *
 *   - **claude-code**: `$CLAUDE_CONFIG_DIR/.claude.json` (default
 *     `~/.claude.json`). The `oauthAccount` sub-object — when present —
 *     carries `emailAddress`, `organizationName`, `displayName`,
 *     `billingType`. Verified by reading
 *     `refs/claude-code/src/services/oauth/client.ts` (the canonical
 *     producer) and the live file on Jackson's machine.
 *
 *   - **codex**: `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`).
 *     Has two mutually-exclusive shapes:
 *       - ChatGPT login → `tokens.id_token` is a JWT whose payload
 *         carries `email` and `https://api.openai.com/auth.chatgpt_plan_type`.
 *       - API-key login → `OPENAI_API_KEY` is a non-null string.
 *     Verified against the live file on Jackson's machine.
 *
 * The functions are pure — fs + env + binary discovery are injected
 * via {@link DetectDeps}, so tests pin every path and the production
 * paths only flow through `defaultDeps`. No subprocess for account
 * detection: we don't shell out to `claude /status` or `codex auth
 * status` — both are slow and the on-disk shape is the source of
 * truth those subcommands print anyway.
 *
 * Error handling: anything that's *not* "logged in"/"not logged in"
 * (file unreadable, JSON parse error, JWT malformed) surfaces as
 * `accountError`. The caller renders that as a muted warning so the
 * user can self-diagnose; we don't pretend "parse failed" means "not
 * logged in".
 */

import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { getCustomEngineIds } from "@/state/repos"
import type { VendorId } from "@/types/vendor"
import { ClaudeBinaryNotFoundError, findClaudeBinary } from "./claude-code-local/binary"
import { CodexBinaryNotFoundError, findCodexBinary } from "./codex-local/binary"
import { CopilotBinaryNotFoundError, findCopilotBinary } from "./copilot-local/binary"

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
  /** Non-fatal error reading account state (file corrupt, JWT malformed, etc.). */
  accountError?: string
}

export interface DetectDeps {
  /** Returns the file contents, or null if the file doesn't exist. Throws on other I/O errors. */
  readFile(path: string): string | null
  env(name: string): string | undefined
  home(): string
  findClaudeBinary(): Promise<string>
  findCodexBinary(): Promise<string>
  findCopilotBinary(): Promise<string>
}

const defaultDeps: DetectDeps = {
  readFile(p: string): string | null {
    try {
      // Guard against directory-not-readable cases. statSync first means
      // we get a cleaner ENOENT signal than readFile's mixed errors.
      statSync(p)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
      throw err
    }
    return readFileSync(p, "utf8")
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

/** Resolve the path to claude-code's global config (`~/.claude.json` by default). */
export function claudeGlobalConfigPath(env: (k: string) => string | undefined, home: string): string {
  const override = env("CLAUDE_CONFIG_DIR")?.trim()
  if (override) return path.join(override, ".claude.json")
  return path.join(home, ".claude.json")
}

/** Resolve the path to codex's auth file (`~/.codex/auth.json` by default). */
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

/**
 * Decode the payload of a JWT (header.payload.signature) without
 * verifying the signature. We're not authenticating the user — we're
 * reading what `codex login` already wrote to disk. The token's
 * trustworthiness is whatever the codex CLI's own trust assumption is.
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".")
  if (parts.length !== 3) return null
  const payload = parts[1]
  if (!payload) return null
  // base64url → base64. Add `=` padding to a multiple of 4 length.
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

/**
 * The vendors whose engine CLI binary is detected on this machine, in
 * {@link VendorId} cycle order (claude → codex → copilot). Pure binary
 * discovery — the same probe the Accounts section uses — with account
 * state deliberately NOT consulted: having the CLI installed is the only
 * gate. The new-task dialog uses this to hide vendors you can't run.
 *
 * Probes run concurrently (each is a `which` + a few `statSync`s); a miss
 * excludes that vendor rather than throwing. Returns `[]` only when none of
 * the three CLIs are found — callers fall back to showing all vendors so an
 * empty selector never blocks task creation.
 */
/**
 * Per-process memo of the production binary-discovery result. Installed engine
 * CLIs don't appear or vanish mid-session, and the underlying `which` is three
 * blocking `spawnSync` probes — uncached this re-runs on every engine-cycle
 * keypress, every new-task dialog open, and every Ctrl+T (~10-15ms render-thread
 * block each, repeated forever for an effectively-constant value). Cached only
 * for the DEFAULT deps (the production path); a caller that injects custom deps
 * (tests, an explicit re-probe) always runs fresh, so injectability and the
 * first-call correctness are preserved.
 */
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

// NOT `async`: a plain function returns the cached promise VERBATIM, so the
// memo is real (an `async` wrapper would mint a fresh outer promise per call
// even when the inner value is cached).
export function detectAvailableVendors(deps: DetectDeps = defaultDeps): Promise<readonly VendorId[]> {
  // Only the production (default-deps) path is memoized — custom deps must
  // re-probe so tests and explicit re-checks stay honest.
  if (deps !== defaultDeps) return probeAvailableVendors(deps)
  if (cachedDefaultVendors) return cachedDefaultVendors
  // Cache the PROMISE (not the resolved value) so concurrent first calls share
  // one probe; on rejection, clear it so a later call can retry.
  const pending = probeAvailableVendors(deps).catch((err) => {
    cachedDefaultVendors = null
    throw err
  })
  cachedDefaultVendors = pending
  return pending
}

/** Drop the memoized production binary-discovery result so the next
 *  {@link detectAvailableVendors} (and {@link availableEngineIds}) re-probes.
 *  For the rare case a CLI is installed/removed mid-session and the UI offers a
 *  "rescan" — the Settings Accounts section is the natural caller. */
export function resetAvailableVendorsCache(): void {
  cachedDefaultVendors = null
}

/**
 * The full engine list to OFFER in the new-task selector: the detected
 * built-ins (above) PLUS every user-registered custom engine. Custom
 * engines are always shown — "the user added it" counts as available, no
 * binary probe (a missing binary just fails to launch with a shell error).
 * Reads the customEngineIds registry from the shared state.json.
 *
 * The built-in probe is memoized per process (see
 * {@link detectAvailableVendors}) since installed CLIs don't change
 * mid-session, but the custom-engine ids are re-read from state.json on EVERY
 * call — state.json can change (Settings → Engines), and only the slow binary
 * `which` probes are worth caching.
 */
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
    // Plan info lives under the namespaced claim `https://api.openai.com/auth`.
    const authClaimRaw = payload["https://api.openai.com/auth"]
    const authClaim =
      typeof authClaimRaw === "object" && authClaimRaw !== null && !Array.isArray(authClaimRaw)
        ? (authClaimRaw as Record<string, unknown>)
        : undefined
    const plan = typeof authClaim?.chatgpt_plan_type === "string" ? authClaim.chatgpt_plan_type : undefined
    if (email) return { binary, account: { kind: "chatgpt", email, plan } }
    // id_token present but no email — surface so the user knows we
    // saw it but couldn't identify the account, rather than silently
    // reporting "not logged in".
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
