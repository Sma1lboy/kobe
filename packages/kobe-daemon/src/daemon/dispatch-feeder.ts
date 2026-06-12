/**
 * Dispatch feeder (docs/design/dispatcher.md) — the daemon-side bridge from
 * the conflict radar to each repo's DISPATCHER session.
 *
 * The dispatcher is the repo's `kind: "main"` task: its engine session is
 * spawned with the dispatcher protocol injected (`withDispatcherProtocol`,
 * packages/kobe/src/engine/interactive-command.ts), so it knows how to act
 * on the radar digests this feeder addresses to it.
 *
 * Mechanics: an in-process bus subscription on `task.conflicts` — every
 * radar publish is regrouped per repo, formatted into a plain-text digest,
 * and published as a `session.deliver` event addressed to that repo's main
 * task. Publish-on-change only (per repo, keyed by the digest text), so a
 * radar tick that didn't change anything feeds nothing; a repo whose pairs
 * all vanish gets ONE all-clear so the dispatcher can stand down. The
 * daemon never delivers text itself — the front-end hosting the session
 * does (the SPA forwards `session.deliver` through /pty/send).
 *
 * Gate: `experimental.dispatcher` (state.json), read fresh per publish so
 * toggling needs no daemon restart.
 */

import { dispatcherEnabled } from "@/state/dispatcher"
import type { Task } from "@/types/task"
import { logDaemonError } from "./crash-log.ts"
import type { DaemonEventBus } from "./event-bus.ts"
import type { ConflictPair, ConflictsPayload } from "./protocol.ts"
import type { TaskLister } from "./worktree-changes-collector.ts"

/** Compose the radar digest one repo's dispatcher receives. Exported for
 *  tests; pure. Tasks are named by title (falling back to branch/id) and
 *  always carry the id the dispatcher needs for `kobe api dispatch`. */
export function formatRadarDigest(pairs: readonly ConflictPair[], tasks: ReadonlyMap<string, Task>): string {
  const name = (id: string): string => {
    const task = tasks.get(id)
    const label = task?.title || task?.branch || id
    return `"${label}" (task ${id})`
  }
  const lines = pairs.map((pair, index) => {
    const level = pair.level === "conflict" ? "CONFLICT" : "overlap"
    return `${index + 1}. ${level}: ${name(pair.a)} ⇄ ${name(pair.b)} — files: ${pair.files.join(", ")}`
  })
  return [
    "[KOBE CONFLICT RADAR]",
    `${pairs.length} pair${pairs.length === 1 ? "" : "s"} among this repo's in-flight tasks:`,
    ...lines,
    "Act per your dispatcher protocol.",
  ].join("\n")
}

/** The one all-clear a repo's dispatcher gets when its last pair resolves. */
export const RADAR_ALL_CLEAR =
  "[KOBE CONFLICT RADAR]\nAll clear — every previously reported pair has resolved. No action needed."

export class DispatchFeeder {
  /** repo → the digest text last fed to its dispatcher (change guard). */
  private readonly lastDigests = new Map<string, string>()
  private unsubscribe: (() => void) | null = null

  constructor(
    private readonly orch: TaskLister,
    private readonly bus: DaemonEventBus,
    private readonly options: {
      readonly enabled?: () => boolean
      readonly now?: () => number
    } = {},
  ) {}

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.bus.onPublish((event) => {
      if (event.channel !== "task.conflicts") return
      try {
        // ChannelEvent isn't a discriminated union (generic payload), so the
        // channel check above doesn't narrow — assert the matching payload.
        this.feed((event.payload as ConflictsPayload).pairs)
      } catch (err) {
        logDaemonError("dispatch-feeder", err)
      }
    })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private feed(pairs: readonly ConflictPair[]): void {
    const enabled = this.options.enabled ?? dispatcherEnabled
    if (!enabled()) return
    const tasks = new Map<string, Task>(this.orch.listTasks().map((t) => [t.id as string, t]))

    // Regroup the global pair list per repo (pairs are same-repo by
    // construction — key off side `a`).
    const byRepo = new Map<string, ConflictPair[]>()
    for (const pair of pairs) {
      const repo = tasks.get(pair.a)?.repo
      if (!repo) continue
      const bucket = byRepo.get(repo)
      if (bucket) bucket.push(pair)
      else byRepo.set(repo, [pair])
    }

    // Every repo that has pairs now, or had a digest before (→ all-clear).
    const repos = new Set<string>([...byRepo.keys(), ...this.lastDigests.keys()])
    for (const repo of repos) {
      const repoPairs = byRepo.get(repo)
      const digest = repoPairs ? formatRadarDigest(repoPairs, tasks) : RADAR_ALL_CLEAR
      if (this.lastDigests.get(repo) === digest) continue
      const main = this.orch.listTasks().find((t) => (t.kind ?? "task") === "main" && t.repo === repo && !t.archived)
      if (!main) continue // no dispatcher seat for this repo — nothing to feed
      if (repoPairs) this.lastDigests.set(repo, digest)
      else this.lastDigests.delete(repo)
      this.bus.publish("session.deliver", {
        taskId: main.id as string,
        text: digest,
        at: (this.options.now ?? Date.now)(),
        source: "radar",
      })
    }
  }
}

export function startDispatchFeeder(orch: TaskLister, bus: DaemonEventBus): DispatchFeeder {
  const feeder = new DispatchFeeder(orch, bus)
  feeder.start()
  return feeder
}
