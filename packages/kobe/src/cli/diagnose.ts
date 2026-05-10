/**
 * `kobe diagnose` — one-shot environment + state report for bug triage.
 *
 * Goal: when a user files an issue ("kobe didn't start", "claude isn't
 * working", "tasks disappeared") they paste the output of this command
 * and we have everything we need to root-cause without back-and-forth.
 *
 * Format choices:
 *   - **Plain text, ASCII only.** No ANSI colors, no box-drawing — the
 *     user might be piping into `pbcopy`, a `gh issue` body, or a chat
 *     window. Anything fancier loses fidelity in transit.
 *   - **Section per concern.** kobe / claude / tmux / state dir / config
 *     dir / worktrees. Each section is independent and prints
 *     `(unavailable: <reason>)` rather than disappearing on failure;
 *     silent gaps mislead.
 *   - **Every probe in try/catch.** A broken `claude --version` (e.g.
 *     binary present but corrupt) cannot be allowed to abort the rest
 *     of the report. The whole point is "I have one button to push
 *     when something is wrong".
 *   - **No network.** `checkLatestVersion()` already caches + has a 3s
 *     timeout + returns null on failure, so it's safe; but we don't
 *     `force: true` (we use the same cache the TUI does), and we're
 *     comfortable printing "no version-check data yet" if the user has
 *     never launched the TUI.
 *
 * Late dynamic-imported from the CLI dispatcher so the diagnose path
 * doesn't pay the cost of loading the Solid graph or opentui.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { stat } from "node:fs/promises"
import { homedir, arch as osArch, platform as osPlatform, release as osRelease } from "node:os"
import { join } from "node:path"
import { findClaudeBinary } from "../engine/claude-code-local/binary.ts"
import { kobeStateDir, tmuxBin } from "../env.ts"
import { TaskIndexStore } from "../orchestrator/index/store.ts"
import { worktreeRootFor } from "../orchestrator/worktree/paths.ts"
import type { Task, TaskStatus } from "../types/task.ts"
import { CURRENT_VERSION, checkLatestVersion } from "../version.ts"

/** Status keys we break down counts by, in canonical display order. */
const STATUS_ORDER: readonly TaskStatus[] = ["backlog", "in_progress", "in_review", "done", "canceled", "error"]

/** Width to pad section keys for "key: value" alignment. */
const KEY_PAD = 18

// --- pure formatting helpers (unit-tested) ----------------------------

/**
 * Format a single "key: value" line, left-padded to a uniform column so
 * a multi-line section stays scannable. Keys longer than the pad width
 * are not truncated — better to break alignment than to lie about names.
 */
export function formatKv(key: string, value: string): string {
  const k = key.length >= KEY_PAD ? key : key.padEnd(KEY_PAD, " ")
  return `${k}${value}`
}

/**
 * Render a `TaskIndex`-shaped list as a per-status breakdown plus a
 * total. Stable status order so two diagnose runs against the same
 * state produce identical output (helpful when diffing reports across
 * a "before this happened / after this happened" pair).
 *
 * Returns a single line like:
 *   "total=7 backlog=1 in_progress=2 done=3 canceled=0 error=1"
 *
 * `in_review` is omitted from the line when zero to keep the output
 * narrow on small terminals; users only see it when it's actually in
 * play. Same logic applied to `canceled` and `error`.
 */
export function formatTaskBreakdown(tasks: readonly Task[]): string {
  const counts: Record<TaskStatus, number> = {
    backlog: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
    canceled: 0,
    error: 0,
  }
  for (const t of tasks) counts[t.status] += 1
  const parts: string[] = [`total=${tasks.length}`]
  for (const s of STATUS_ORDER) {
    // Always show backlog/in_progress/done so the line shape is
    // predictable; suppress the "rare" terminal states when they're
    // zero. Anyone diagnosing will still notice "huh, no canceled
    // line — must be zero" faster than they'd notice a missing field
    // when one is present.
    if (counts[s] === 0 && (s === "in_review" || s === "canceled" || s === "error")) continue
    parts.push(`${s}=${counts[s]}`)
  }
  return parts.join(" ")
}

/**
 * Convert a raw byte count into a human-readable unit. We round to one
 * decimal place above KB; below that we report the integer byte count
 * because a half-byte makes no sense. Used for `~/.kobe/` size and
 * state.json size.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "(unknown)"
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unitIdx = 0
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024
    unitIdx += 1
  }
  return `${value.toFixed(1)} ${units[unitIdx]}`
}

/**
 * Compute the shape of the worktree-vs-task reconciliation report.
 *
 * Returns a small object describing:
 *   - tasks that point at a worktree path that doesn't exist on disk
 *     ("missing" — the manifest is referencing a vanished worktree)
 *   - worktree dirs on disk that no task references ("dangling" — likely
 *     leftovers from a crashed delete or a manual intervention)
 *
 * Pure function so it's unit-testable. The IO of "what tasks exist" and
 * "what dirs exist on disk" is the caller's job; we just compare the
 * two sets.
 */
export function reconcileWorktrees(
  tasks: readonly Pick<Task, "id" | "worktreePath" | "repo">[],
  onDiskByRepo: ReadonlyMap<string, readonly string[]>,
): {
  taskCount: number
  onDiskCount: number
  missing: string[]
  dangling: string[]
} {
  const onDiskAbs = new Set<string>()
  for (const [repo, names] of onDiskByRepo) {
    const root = worktreeRootFor(repo)
    for (const n of names) onDiskAbs.add(join(root, n))
  }
  const referenced = new Set<string>()
  for (const t of tasks) referenced.add(t.worktreePath)

  const missing: string[] = []
  for (const t of tasks) {
    if (!onDiskAbs.has(t.worktreePath)) missing.push(t.worktreePath)
  }
  const dangling: string[] = []
  for (const p of onDiskAbs) {
    if (!referenced.has(p)) dangling.push(p)
  }
  return {
    taskCount: tasks.length,
    onDiskCount: onDiskAbs.size,
    missing,
    dangling,
  }
}

// --- IO probes (not unit-tested; wrapped in try/catch each) -----------

/**
 * Try to read a binary's `--version`. Strips trailing whitespace; we
 * don't try to parse it because every CLI's format is different
 * (`claude` prints `1.x.y (Claude Code)`, `tmux` prints `tmux 3.x`).
 * Caller already knows what binary they asked about.
 *
 * Returns null on any failure: missing binary, non-zero exit, timeout.
 */
function probeVersion(bin: string): string | null {
  try {
    const out = spawnSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: 3_000,
    })
    if (out.status !== 0) {
      // tmux uses `-V`, not `--version`. Try once more before giving up
      // — covers the most common case without having to special-case
      // each binary up here.
      const alt = spawnSync(bin, ["-V"], { encoding: "utf8", timeout: 3_000 })
      if (alt.status !== 0) return null
      return alt.stdout.trim() || alt.stderr.trim() || null
    }
    return out.stdout.trim() || out.stderr.trim() || null
  } catch {
    return null
  }
}

/**
 * Recursive directory size walk. We don't follow symlinks (a `~/.kobe/`
 * with a symlink loop would otherwise infinite-loop and crash the
 * report). Returns null when we can't even stat the root — the caller
 * formats that as `(unavailable: ...)`.
 */
function dirSize(root: string): number | null {
  try {
    const st = statSync(root)
    if (!st.isDirectory()) return st.size
  } catch {
    return null
  }
  let total = 0
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    if (!dir) continue
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (st.isSymbolicLink()) continue
        if (st.isDirectory()) stack.push(full)
        else total += st.size
      } catch {
        // Permission denied / vanished file — skip and keep going.
      }
    }
  }
  return total
}

/**
 * List immediate child directory names under `root` that look like
 * task ULIDs. We intentionally don't check the ULID format (a manual
 * test rename shouldn't make us miss it); we just report every
 * directory entry. Returns empty array if `root` doesn't exist.
 */
function listWorktreeDirs(root: string): string[] {
  try {
    return readdirSync(root).filter((n) => {
      try {
        return statSync(join(root, n)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

/**
 * Tail the last N lines of a file. Returns an empty array if the file
 * doesn't exist or can't be read. Used by the recent-errors section
 * once any rolling error log exists; today nothing in the tree writes
 * such a file, but the section is wired so adding one later is a
 * one-line change.
 */
function tailLines(path: string, n: number): string[] {
  try {
    const text = require("node:fs").readFileSync(path, "utf8") as string
    const lines = text.split("\n").filter((l: string) => l.length > 0)
    return lines.slice(-n)
  } catch {
    return []
  }
}

// --- the report -------------------------------------------------------

/** Build the full diagnose report as a string (no IO of its own beyond
 *  what the helpers do). Exported so tests / callers other than the CLI
 *  can ask for the same payload (e.g. an in-app "copy diagnostics"
 *  button). */
export async function buildDiagnoseReport(): Promise<string> {
  const lines: string[] = []
  const section = (title: string) => {
    if (lines.length > 0) lines.push("")
    lines.push(`== ${title} ==`)
  }

  // --- kobe ---
  section("kobe")
  lines.push(formatKv("version:", CURRENT_VERSION))
  let latest: string | null = null
  try {
    const info = await checkLatestVersion()
    if (info) {
      latest = info.latest
      const suffix = info.hasUpdate ? " (update available)" : ""
      lines.push(formatKv("npm latest:", `${info.latest}${suffix}`))
    } else {
      lines.push(formatKv("npm latest:", "(unavailable: no cache, offline, or KOBE_DEV=1)"))
    }
  } catch (err) {
    lines.push(formatKv("npm latest:", `(unavailable: ${(err as Error).message})`))
  }
  lines.push(formatKv("os:", `${osPlatform()} ${osRelease()}`))
  lines.push(formatKv("arch:", osArch()))
  lines.push(formatKv("bun:", process.versions.bun ?? "(not running on bun)"))
  lines.push(formatKv("node:", process.versions.node))
  void latest // kept for potential future per-section logic

  // --- claude binary ---
  section("claude binary")
  let claudePath: string | null = null
  try {
    claudePath = await findClaudeBinary()
    lines.push(formatKv("path:", claudePath))
    const v = probeVersion(claudePath)
    lines.push(formatKv("version:", v ?? "(unavailable: --version failed)"))
  } catch (err) {
    lines.push(formatKv("path:", "NOT FOUND"))
    const msg = err instanceof Error ? err.message : String(err)
    lines.push(
      formatKv("hint:", "install Claude Code so `which claude` works, or drop the binary at ~/.claude/local/claude"),
    )
    lines.push(formatKv("detail:", msg))
  }

  // --- tmux ---
  section("tmux")
  const tmux = tmuxBin()
  // `which` lookup so we report the absolute path the embedded terminal
  // pane will actually invoke, not just the configured name.
  let tmuxPath: string | null = null
  try {
    const out = spawnSync(process.platform === "win32" ? "where" : "which", [tmux], {
      encoding: "utf8",
      timeout: 3_000,
    })
    if (out.status === 0) {
      tmuxPath =
        out.stdout
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.length > 0) ?? null
    }
  } catch {
    /* swallow — handled below */
  }
  if (tmuxPath) {
    lines.push(formatKv("path:", tmuxPath))
    const v = probeVersion(tmuxPath)
    lines.push(formatKv("version:", v ?? "(unavailable: -V failed)"))
  } else {
    lines.push(formatKv("path:", "NOT FOUND"))
    lines.push(formatKv("hint:", "install tmux (e.g. `brew install tmux`); the terminal pane needs it"))
  }

  // --- state dir (~/.kobe/) ---
  section("state dir (~/.kobe/)")
  const stateDir = kobeStateDir()
  lines.push(formatKv("path:", stateDir))
  if (existsSync(stateDir)) {
    lines.push(formatKv("exists:", "yes"))
    const size = dirSize(stateDir)
    lines.push(formatKv("size:", size === null ? "(unavailable)" : formatBytes(size)))
  } else {
    lines.push(formatKv("exists:", "no (will be created on first task)"))
  }

  // tasks.json — always try to load, even if dir doesn't exist (load()
  // tolerates ENOENT and reports zero tasks). Wrap in try/catch in case
  // the file is unreadable for some other reason (perm, EISDIR).
  let tasks: Task[] = []
  let taskLoadError: string | null = null
  try {
    const store = new TaskIndexStore({ homeDir: homedir() })
    await store.load()
    tasks = store.list()
  } catch (err) {
    taskLoadError = (err as Error).message
  }
  if (taskLoadError) {
    lines.push(formatKv("tasks.json:", `(unavailable: ${taskLoadError})`))
  } else {
    lines.push(formatKv("tasks.json:", formatTaskBreakdown(tasks)))
  }

  // --- config dir (~/.config/kobe/) ---
  section("config dir (~/.config/kobe/)")
  const configDir = join(homedir(), ".config", "kobe")
  const stateJsonPath = join(configDir, "state.json")
  lines.push(formatKv("path:", configDir))
  if (existsSync(configDir)) {
    lines.push(formatKv("exists:", "yes"))
    try {
      const st = await stat(stateJsonPath)
      lines.push(formatKv("state.json:", `${formatBytes(st.size)}`))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        lines.push(formatKv("state.json:", "missing (no UI prefs persisted yet)"))
      } else {
        lines.push(formatKv("state.json:", `(unavailable: ${(err as Error).message})`))
      }
    }
  } else {
    lines.push(formatKv("exists:", "no (no UI prefs persisted yet)"))
  }

  // --- worktrees ---
  section("worktrees")
  if (taskLoadError) {
    lines.push(formatKv("status:", `(unavailable: tasks.json load failed — ${taskLoadError})`))
  } else if (tasks.length === 0) {
    lines.push(formatKv("status:", "no tasks; nothing to scan"))
  } else {
    // Group tasks by repo so we scan each repo's worktree root once.
    const repos = new Set<string>()
    for (const t of tasks) repos.add(t.repo)
    const onDiskByRepo = new Map<string, readonly string[]>()
    for (const repo of repos) {
      try {
        const root = worktreeRootFor(repo)
        onDiskByRepo.set(repo, listWorktreeDirs(root))
      } catch (err) {
        // Bad repo path (e.g. relative) — skip but keep going.
        lines.push(formatKv("scan-error:", `${repo}: ${(err as Error).message}`))
        onDiskByRepo.set(repo, [])
      }
    }
    const report = reconcileWorktrees(tasks, onDiskByRepo)
    lines.push(formatKv("repos:", String(repos.size)))
    lines.push(formatKv("tasks ref'd:", String(report.taskCount)))
    lines.push(formatKv("dirs on disk:", String(report.onDiskCount)))
    lines.push(formatKv("missing:", String(report.missing.length)))
    if (report.missing.length > 0) {
      for (const p of report.missing.slice(0, 5)) lines.push(`  - missing: ${p}`)
      if (report.missing.length > 5) lines.push(`  - ... ${report.missing.length - 5} more`)
    }
    lines.push(formatKv("dangling:", String(report.dangling.length)))
    if (report.dangling.length > 0) {
      for (const p of report.dangling.slice(0, 5)) lines.push(`  - dangling: ${p}`)
      if (report.dangling.length > 5) lines.push(`  - ... ${report.dangling.length - 5} more`)
    }
  }

  // --- recent errors ---
  section("recent errors")
  // No rolling error log exists today (verified via grep for crash-logs
  // / error-log / errorLog at write time). When one is added, point
  // `errorLogPath` at it and the tail() helper will populate this
  // section automatically. We still print the section so users don't
  // wonder whether we just forgot it.
  const errorLogPath = join(stateDir, "crash-logs", "latest.log")
  if (existsSync(errorLogPath)) {
    const tail = tailLines(errorLogPath, 5)
    if (tail.length === 0) {
      lines.push(formatKv("crash log:", "(empty)"))
    } else {
      lines.push(formatKv("crash log:", `last ${tail.length} entries from ${errorLogPath}`))
      for (const t of tail) lines.push(`  ${t}`)
    }
  } else {
    lines.push(formatKv("crash log:", "(none — kobe does not write a rolling error log yet)"))
  }

  return lines.join("\n")
}

/**
 * CLI entry point — print the report to stdout and return.
 *
 * Exits with status 0 on success regardless of what the report contains:
 * `kobe diagnose` is a tool for the user to copy-paste into a bug
 * report, and a non-zero exit would make `kobe diagnose | pbcopy` look
 * like the diagnose itself failed when really it's just reporting that
 * (say) tmux is missing.
 */
export async function runDiagnoseSubcommand(): Promise<void> {
  const report = await buildDiagnoseReport()
  process.stdout.write(`${report}\n`)
}
