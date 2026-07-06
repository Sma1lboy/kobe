import { stat } from "node:fs/promises"
import { join } from "node:path"
import { readOnlyGitProcessEnv } from "@/lib/git-env"
import { sessionAttached } from "@/tui/lib/attach-gate"
import { createBackgroundPoller, spawnCapture } from "../../lib/background-poll"

export const BRANCH_POLL_TIMEOUT_MS = 2_000
export const BRANCH_SLOW_RETRY_MS = 30_000
export const BRANCH_MIN_POLL_INTERVAL_MS = 1_500

const headCache = new Map<string, { fingerprint: string; value: string }>()

async function headFingerprint(repo: string): Promise<string | null> {
  try {
    const st = await stat(join(repo, ".git", "HEAD"))
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return null
  }
}

export async function resolveBranchHead(
  repo: string,
  signal: AbortSignal,
  spawn: typeof spawnCapture = spawnCapture,
): Promise<string> {
  const fingerprint = await headFingerprint(repo)
  if (fingerprint !== null) {
    const cached = headCache.get(repo)
    if (cached && cached.fingerprint === fingerprint) return cached.value
  }
  let value = ""
  let resolved = false
  const ref = await spawn("git", ["symbolic-ref", "--short", "HEAD"], {
    cwd: repo,
    env: readOnlyGitProcessEnv(),
    signal,
  })
  const name = ref.status === 0 ? ref.stdout.trim() : ""
  if (name && name !== "HEAD") {
    value = name
    resolved = true
  } else {
    const head = await spawn("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repo,
      env: readOnlyGitProcessEnv(),
      signal,
    })
    if (head.status === 0) {
      value = "(detached)"
      resolved = true
    }
  }
  if (resolved && fingerprint !== null) headCache.set(repo, { fingerprint, value })
  return value
}

const poller = createBackgroundPoller<string>({
  initial: "",
  timeoutMs: BRANCH_POLL_TIMEOUT_MS,
  slowRetryMs: BRANCH_SLOW_RETRY_MS,
  minIntervalMs: BRANCH_MIN_POLL_INTERVAL_MS,
  run: (repo, signal) => resolveBranchHead(repo, signal),
})

export function currentBranch(repo: string): string {
  return poller.read(repo)
}

export function pollCurrentBranch(repo: string): void {
  void sessionAttached().then((attached) => {
    if (attached) poller.poll(repo)
  })
}

export function resetGitHeadPoller(): void {
  poller.reset()
  headCache.clear()
}
