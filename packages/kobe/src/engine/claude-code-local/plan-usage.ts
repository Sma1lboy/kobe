/**
 * Plan-usage fetcher — ports the surface of claude-code's `/usage` command
 * (interactive only there; we want a passive topbar readout in kobe).
 *
 * Two responsibilities, both read-only:
 *   1. Locate claude-code's OAuth access token (macOS Keychain or the Linux
 *      plaintext fallback at `$CLAUDE_CONFIG_DIR/.credentials.json`).
 *   2. Call `GET https://api.anthropic.com/api/oauth/usage` and normalise
 *      the response shape — see `refs/claude-code/src/services/api/usage.ts`.
 *
 * Read-only on purpose: refreshing the token would require borrowing
 * claude-code's `client_id` and writing back into its credentials store,
 * which is past the boundary of "kobe wraps claude." If the token is
 * expired the fetch returns `null` and the topbar simply omits the chip
 * until the user runs `claude` (which refreshes on its own).
 */

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { PlanRateLimit, PlanUsage } from "../../types/plan-usage.ts"

const execFileAsync = promisify(execFile)

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
const FETCH_TIMEOUT_MS = 5000
const KEYCHAIN_BASE = "Claude Code"
const KEYCHAIN_SUFFIX = "-credentials"

interface StoredOAuth {
  readonly accessToken: string
  readonly refreshToken?: string | null
  readonly expiresAt?: number
  readonly scopes?: ReadonlyArray<string>
}

interface RawUsageResponse {
  readonly five_hour?: RawBucket | null
  readonly seven_day?: RawBucket | null
  readonly seven_day_opus?: RawBucket | null
  readonly seven_day_sonnet?: RawBucket | null
}

interface RawBucket {
  readonly utilization?: number | null
  readonly resets_at?: string | null
}

/**
 * Match `getMacOsKeychainStorageServiceName("-credentials")` in
 * `refs/claude-code/src/utils/secureStorage/macOsKeychainHelpers.ts`. The
 * dir-hash suffix only kicks in when `CLAUDE_CONFIG_DIR` is set — default
 * installs land on `"Claude Code-credentials"` flat.
 */
function keychainServiceName(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR
  if (!configDir) return `${KEYCHAIN_BASE}${KEYCHAIN_SUFFIX}`
  const hash = createHash("sha256").update(configDir).digest("hex").slice(0, 8)
  return `${KEYCHAIN_BASE}${KEYCHAIN_SUFFIX}-${hash}`
}

function keychainAccount(): string {
  return process.env.USER || userInfo().username || "claude-code-user"
}

async function readKeychainToken(): Promise<StoredOAuth | null> {
  if (process.platform !== "darwin") return null
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-a",
      keychainAccount(),
      "-w",
      "-s",
      keychainServiceName(),
    ])
    return parseStoredOAuth(stdout)
  } catch {
    return null
  }
}

async function readPlainTextToken(): Promise<StoredOAuth | null> {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
  const path = join(configDir, ".credentials.json")
  try {
    const raw = await readFile(path, "utf8")
    return parseStoredOAuth(raw)
  } catch {
    return null
  }
}

function parseStoredOAuth(raw: string): StoredOAuth | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as { claudeAiOauth?: StoredOAuth }
    const tok = parsed.claudeAiOauth
    if (!tok || typeof tok.accessToken !== "string" || tok.accessToken.length === 0) return null
    return tok
  } catch {
    return null
  }
}

async function loadToken(): Promise<StoredOAuth | null> {
  return (await readKeychainToken()) ?? (await readPlainTextToken())
}

function normalizeBucket(b: RawBucket | null | undefined): PlanRateLimit | null {
  if (!b) return null
  return {
    utilization: typeof b.utilization === "number" && Number.isFinite(b.utilization) ? b.utilization : null,
    resetsAt: typeof b.resets_at === "string" && b.resets_at.length > 0 ? b.resets_at : null,
  }
}

/**
 * Best-effort fetch of the user's plan utilization. Returns `null` on:
 *   - no token (claude-code not signed in)
 *   - token expired (we refuse to refresh)
 *   - network error / non-2xx / parse error / timeout
 *
 * Never throws — the topbar simply hides the chip when this returns null.
 */
export async function fetchPlanUsage(now: number = Date.now()): Promise<PlanUsage | null> {
  const token = await loadToken()
  if (!token) return null
  if (typeof token.expiresAt === "number" && token.expiresAt > 0 && token.expiresAt < now) return null

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(USAGE_URL, {
      signal: ctrl.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "kobe-plan-usage",
        "anthropic-beta": "oauth-2025-04-20",
        authorization: `Bearer ${token.accessToken}`,
      },
    })
    if (!res.ok) return null
    const body = (await res.json()) as RawUsageResponse
    return {
      fiveHour: normalizeBucket(body.five_hour),
      sevenDay: normalizeBucket(body.seven_day),
      sevenDayOpus: normalizeBucket(body.seven_day_opus),
      sevenDaySonnet: normalizeBucket(body.seven_day_sonnet),
      fetchedAt: new Date(now).toISOString(),
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
