/**
 * `bun e2e/hero-seed.ts` — run the REAL engine sessions the README assets are
 * shot around: two tasks working at once on DISJOINT files, each on its own
 * worktree and branch. That is the product's claim, so it is photographed
 * rather than asserted.
 *
 * Costs real quota and is nondeterministic by construction — two live turns.
 * Budget a few minutes, and expect the transcript (and so the framing) to
 * differ between runs. Already-seeded tasks are left alone, so a re-shoot
 * reuses the sessions it has already paid for; `hero-fixture.ts --fresh`
 * starts over.
 *
 * Two things have to be arranged before the engine starts, or the turn stalls
 * where no operator is watching:
 *
 * - **Folder trust.** A Rove worktree is its own git root, so Claude Code
 *   treats it as a new project and opens "Is this a project you trust?" —
 *   trust on an ancestor does NOT carry into it. That dialog cannot simply be
 *   answered after the fact: the task's prompt rides in on argv, and
 *   accepting the dialog drops it, leaving a live session that never got
 *   asked anything. So the worktree is materialized first
 *   (`ensure-worktree`), recorded as trusted, and only then handed a prompt.
 *   The record is additive — an entry the operator already has is never
 *   rewritten, and nothing else in the file is touched.
 * - **Command approval.** `acceptEdits` covers file edits only. Both prompts
 *   end in a commit, and a bare Bash call would stop on an approval nobody is
 *   there to answer, so `hero-fixture.ts` pins `--allowedTools "Bash(git *)"`
 *   as the narrow fix — never `bypassPermissions`, which would hand an
 *   unattended agent the operator's real HOME.
 */

import { existsSync } from "node:fs"
import { readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { HERO_REPO } from "./hero-env.ts"
import { heroApi, heroRun } from "./hero-fixture.ts"

type Seed = { readonly title: string; readonly prompt: string }

const SEEDS: readonly Seed[] = [
  {
    title: "Add a request timeout",
    prompt: "Add a 5s request timeout to createClient in src/client.ts, then commit it.",
  },
  {
    title: "Retry rate limits",
    prompt: "Treat HTTP 429 as retryable in src/retry.ts and cover it in test/client.test.ts, then commit it.",
  },
]

type Task = { id: string; title: string; worktreePath: string; branch: string }

function tasks(): Task[] {
  return (heroApi(["list"]) as { tasks?: Task[] }).tasks ?? []
}

function committed(task: Task): boolean {
  if (!task.worktreePath) return false
  try {
    return heroRun("git", ["log", "--oneline", "main..HEAD"], task.worktreePath).length > 0
  } catch {
    return false
  }
}

/** Additive trust record for one worktree; leaves every other key alone. */
async function trustFolder(path: string): Promise<void> {
  const config = join(homedir(), ".claude.json")
  if (!existsSync(config)) throw new Error(`no ${config} to record folder trust in`)
  const parsed = JSON.parse(await readFile(config, "utf8")) as {
    projects?: Record<string, Record<string, unknown>>
  }
  const projects = parsed.projects ?? (parsed.projects = {})
  if (projects[path]?.hasTrustDialogAccepted === true) return
  projects[path] = { ...projects[path], hasTrustDialogAccepted: true }
  const staged = `${config}.hero-${process.pid}`
  await writeFile(staged, `${JSON.stringify(parsed, null, 2)}\n`)
  await rename(staged, config)
}

/** The engine has a transcript of its own — i.e. the turn actually began. */
function turnStarted(taskId: string): boolean {
  const output = heroApi(["read-output", "--task-id", taskId]) as { source?: string }
  return output.source === "history"
}

const existing = new Map(tasks().map((task) => [task.title, task]))
const pending: { id: string; seed: Seed }[] = []
for (const seed of SEEDS) {
  if (existing.has(seed.title)) {
    console.log(`[hero] reusing session: ${seed.title}`)
    continue
  }
  const created = heroApi(["add", "--repo", HERO_REPO, "--title", seed.title, "--vendor", "claude"]) as {
    taskId?: string
  }
  if (!created.taskId) throw new Error(`hero seed created no task for ${seed.title}`)
  const worktree = heroApi(["ensure-worktree", "--task-id", created.taskId]) as { worktreePath?: string }
  if (!worktree.worktreePath) throw new Error(`hero seed materialized no worktree for ${seed.title}`)
  await trustFolder(worktree.worktreePath)
  console.log(`[hero] starting: ${seed.title} → ${worktree.worktreePath}`)
  heroApi(["send", "--task-id", created.taskId, "--prompt", seed.prompt])
  pending.push({ id: created.taskId, seed })
}

// Starting a session hands the prompt to the engine on argv, and Claude Code
// does not always act on it — a booted session then sits idle forever with
// nothing asked of it, which reads as a hung capture. The engine's own
// transcript is the honest signal that a turn began; if none exists once the
// UI is up, deliver the prompt the way an operator would, as a paste.
for (const { id, seed } of pending) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (turnStarted(id)) break
    await new Promise((wake) => setTimeout(wake, 5_000))
  }
  if (turnStarted(id)) continue
  console.log(`[hero] re-delivering prompt: ${seed.title}`)
  heroApi(["send", "--task-id", id, "--plain", "--prompt", seed.prompt])
}

const deadline = Date.now() + 12 * 60_000
for (;;) {
  const live = tasks().filter((task) => SEEDS.some((seed) => seed.title === task.title))
  const done = live.filter(committed)
  console.log(`[hero] committed ${done.length}/${SEEDS.length} · ${live.map((task) => task.branch || "…").join(" ")}`)
  if (done.length === SEEDS.length) break
  if (Date.now() > deadline) {
    console.error("[hero] timed out waiting for both turns to commit — inspect the sessions before shooting")
    process.exit(1)
  }
  await new Promise((wake) => setTimeout(wake, 10_000))
}
console.log("[hero] both turns landed")
