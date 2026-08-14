/**
 * `bun e2e/hero-issues.ts` — seed the hero fixture's KANBAN board: the
 * daemon-owned issue store filled with a plausible backlog, stories already
 * linked to running tasks, and shipped work in Done.
 *
 * Split from `hero-fixture.ts` for the same reason `hero-seed.ts` is: the
 * fixture is the cheap part and gets rebuilt often, while the board is what
 * the kanban captures are OF and wants to be re-seedable on its own.
 *
 * Costs no engine quota. A story reaches In progress by being LINKED to a
 * task (`issue-update --task`) — that link IS the column, exactly how an
 * agent moves its own card — so the idle tasks `hero-fixture.ts` already
 * created are enough to populate it.
 *
 * Idempotent: a board that already carries these titles is left alone, so a
 * re-shoot keeps the ids the earlier stills were framed on.
 */

import { HERO_REPO } from "./hero-env.ts"
import { heroApi } from "./hero-fixture.ts"

type Story = {
  readonly title: string
  readonly body: string
  /** `hold` reads as the warning chip on a backlog card. */
  readonly status?: "hold" | "done"
  /**
   * Title of an EXISTING fixture task to link this story to — the link is
   * what puts a card in the In-progress column. Missing task: the story just
   * stays in Backlog. Nothing here creates a task, because a task carrying a
   * `hero-seed.ts` title would make the next seeding run think it had already
   * paid for that session and skip it, leaving the README demo sessionless.
   */
  readonly task?: string
}

/**
 * Board contents. Titles are what the columns are read by, so they stay
 * short enough to sit on one card line; bodies stay within the card's
 * two-line preview and carry the rest in the detail drawer.
 */
const STORIES: readonly Story[] = [
  {
    title: "Add a request timeout",
    body: "createClient should stop waiting after 5s and surface a typed TimeoutError.",
    task: "Add a request timeout",
  },
  {
    title: "Port the docs snippets",
    body: "Every snippet in docs/ still constructs the pre-1.0 client. Move them to createClient.",
    task: "Port the docs snippets to the new client",
  },
  {
    title: "Audit token refresh under clock skew",
    body: "A client whose clock runs fast refreshes early and thrashes the auth endpoint.",
    task: "Audit token refresh under clock skew",
  },
  {
    title: "Retry rate limits with backoff",
    body: "Treat HTTP 429 as retryable with jittered backoff, and cap total wait at 30s.",
  },
  {
    title: "Typed errors on the client surface",
    body: "Callers currently match on message strings. Export an OrbitError union instead.",
  },
  {
    title: "Cache discovery documents",
    body: "One discovery fetch per host per process, invalidated on a 401.",
    status: "hold",
  },
  {
    title: "Drop the Node 18 polyfill path",
    body: "fetch and AbortSignal.timeout are native on every supported runtime now.",
  },
  {
    title: "Streaming upload API",
    body: "Accept a ReadableStream body and stop buffering whole files in memory.",
    status: "done",
  },
  {
    title: "Move auth refresh off the request path",
    body: "Refresh in the background instead of blocking the first call after expiry.",
    status: "done",
  },
]

type Issue = { id: number; title: string }
type Task = { id: string; title: string }

function board(): Issue[] {
  return (heroApi(["issue-list", "--repo", HERO_REPO]) as { issues?: Issue[] }).issues ?? []
}

const tasks = new Map(
  ((heroApi(["list"]) as { tasks?: Task[] }).tasks ?? []).map((task) => [task.title, task.id] as const),
)
const existing = new Set(board().map((issue) => issue.title))

for (const story of STORIES) {
  if (existing.has(story.title)) {
    console.log(`[hero:issues] reusing story: ${story.title}`)
    continue
  }
  const created = heroApi(["issue-create", "--repo", HERO_REPO, "--title", story.title, "--body", story.body])
  // `issue.mutate` answers with the whole board, so the new id is the record
  // that was not there a moment ago — the daemon owns id allocation.
  const id = ((created as { issues?: Issue[] }).issues ?? []).find((issue) => issue.title === story.title)?.id
  if (id === undefined) throw new Error(`issue-create returned no record for ${story.title}`)

  const taskId = story.task ? tasks.get(story.task) : undefined
  if (story.task && !taskId) console.log(`[hero:issues] no task ${JSON.stringify(story.task)} yet — #${id} stays open`)
  if (taskId) heroApi(["issue-update", "--repo", HERO_REPO, "--id", String(id), "--task", taskId])
  if (story.status) heroApi(["issue-set-status", "--repo", HERO_REPO, "--id", String(id), "--status", story.status])
  console.log(`[hero:issues] #${id} ${story.title}${taskId ? " → in progress" : ""}`)
}

console.log(`[hero:issues] ${board().length} stories on ${HERO_REPO}`)
