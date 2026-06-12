/**
 * Auto in-review status judge (docs/design/web-kanban.md M5).
 *
 * When an engine reports `turn-complete`, the daemon may advance the task
 * `in_progress → in_review` so the board reflects "this session thinks it's
 * done" without the user dragging the card. Two tiers keep it cheap and
 * conservative:
 *
 *   1. FREE heuristic gate — only an `in_progress`, non-main, non-archived
 *      task with review-ready evidence (dirty worktree OR an open PR) is a
 *      candidate. Most turn-completes stop here.
 *   2. SMALL-MODEL judge — `claude -p --model haiku` classifies the agent's
 *      FINAL message: "work complete" vs "mid-task / asking the user".
 *      A turn that ends with a question fires the same Stop hook as a real
 *      completion, which is exactly the case heuristics can't tell apart.
 *
 * Guardrails (the auto-done incident is the cautionary tale — see
 * coerceTask's heal notes): the ONLY transition ever made is
 * `in_progress → in_review`; never done/canceled. A user move wins: the
 * task's status is re-checked after the judge returns, and anything but
 * `in_progress` aborts. Off by default — enabled per user via the
 * `autoInReview` key in state.json, re-read on every event so toggling
 * needs no daemon restart.
 *
 * The judge input is engine-neutral (the vendor's history reader yields
 * neutral Messages — the auto-title precedent); the judge MODEL is the
 * claude CLI regardless of the task's vendor, because it is a tool of the
 * daemon, not the task's engine. No claude binary → judge unavailable →
 * skip (never move on heuristics alone).
 */

import { execFile } from "node:child_process"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { findClaudeBinary } from "@/engine/claude-code-local/binary"
import { engineEntry } from "@/engine/registry"
import { loadStateFile } from "@/state/store"
import type { Message } from "@/types/engine"
import { DEFAULT_TASK_VENDOR, type Task, type TaskStatus, type VendorId } from "@/types/task"

const execFileAsync = promisify(execFile)

/** Override with KOBE_JUDGE_MODEL; haiku is the cheap/fast default. */
export const DEFAULT_JUDGE_MODEL = "claude-haiku-4-5"

/** Final-message tail handed to the judge — endings carry the verdict
 *  ("tests pass", "let me know which option…"), so truncate from the front. */
const JUDGE_INPUT_MAX_CHARS = 4000

const JUDGE_TIMEOUT_MS = 30_000

/** The minimal orchestrator surface the judge needs (structural, so tests
 *  fake it and the daemon passes the real Orchestrator). */
export interface StatusJudgeOrchestrator {
  getTask(id: string): Task | undefined
  setStatus(id: string, status: TaskStatus): Promise<void>
}

export interface AutoReviewDeps {
  readonly enabled: () => boolean
  readonly lastAssistantText: (worktree: string, vendor: VendorId) => Promise<string>
  readonly isDirty: (worktree: string) => Promise<boolean>
  readonly judge: (finalMessage: string) => Promise<boolean | null>
}

/** The text of the LAST assistant message in a session transcript. */
export function lastAssistantTextFromMessages(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.role !== "assistant") continue
    const text = message.blocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim()
    if (text) return text
  }
  return ""
}

/** The last assistant message of the task's LATEST session (engine-owned
 *  history; vendor-neutral Message[] — the auto-title precedent). */
export async function lastAssistantTextForWorktree(
  worktree: string,
  vendor: VendorId = DEFAULT_TASK_VENDOR,
): Promise<string> {
  if (!worktree) return ""
  try {
    const { history } = engineEntry(vendor)
    const ids = await history.listSessionIdsForWorktree(worktree)
    const latest = ids[ids.length - 1]
    if (!latest) return ""
    return lastAssistantTextFromMessages(await history.readHistory(latest))
  } catch {
    return ""
  }
}

/** Free tier-1 gate: only review-ready evidence makes a judge call worth it. */
export function isReviewCandidate(task: Task, dirty: boolean): boolean {
  if ((task.kind ?? "task") === "main" || task.archived) return false
  if (task.status !== "in_progress") return false
  const pr = task.prStatus?.lifecycle
  return dirty || pr === "open" || pr === "ready_to_merge"
}

export function buildJudgePrompt(finalMessage: string): string {
  const tail = finalMessage.slice(-JUDGE_INPUT_MAX_CHARS)
  return [
    "You are a status judge for a kanban board of AI coding sessions.",
    "Below is the FINAL message an AI coding agent wrote at the end of its latest turn.",
    "Decide whether the work item is ready for human review:",
    '- Answer "REVIEW" only if the agent states the requested work is complete (implemented / fixed / verified / committed).',
    '- Answer "CONTINUE" if the agent is mid-task, asking the user a question, presenting options, awaiting input, reporting partial progress, or just conversing.',
    "Answer with exactly one word: REVIEW or CONTINUE.",
    "",
    "Final message:",
    '"""',
    tail,
    '"""',
  ].join("\n")
}

/** Parse the judge's one-word verdict. Null = unusable output → skip. */
export function parseVerdict(output: string): boolean | null {
  const out = output.trim().toUpperCase()
  if (out.startsWith("REVIEW")) return true
  if (out.startsWith("CONTINUE")) return false
  if (out.includes("REVIEW") && !out.includes("CONTINUE")) return true
  return null
}

/** Live-read the opt-in flag from state.json (no daemon restart to toggle). */
export function autoReviewEnabled(): boolean {
  return loadStateFile().autoInReview === true
}

async function gitDirty(worktree: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: worktree,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

/** Headless haiku call via the user's existing claude login. Null on any
 *  failure (missing binary, timeout, junk output) — failures must skip,
 *  never advance. */
async function judgeWithClaude(finalMessage: string): Promise<boolean | null> {
  try {
    const bin = await findClaudeBinary()
    const model = process.env.KOBE_JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL
    const { stdout } = await execFileAsync(
      bin,
      ["-p", buildJudgePrompt(finalMessage), "--model", model, "--output-format", "text"],
      // tmpdir cwd: the judge must not inherit the worktree's project
      // context (CLAUDE.md, hooks) — it's a one-shot classifier.
      { cwd: tmpdir(), timeout: JUDGE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    )
    return parseVerdict(stdout)
  } catch {
    return null
  }
}

const defaultDeps: AutoReviewDeps = {
  enabled: autoReviewEnabled,
  lastAssistantText: lastAssistantTextForWorktree,
  isDirty: gitDirty,
  judge: judgeWithClaude,
}

/** One judge per task at a time — turn-completes can burst on reconnect. */
const inFlight = new Set<string>()

export type AutoReviewResult = "moved" | "skipped"

/**
 * Run the full pipeline for one turn-complete. Best-effort: every failure
 * path skips. The status is re-checked AFTER the judge returns so a user
 * move (or another client's change) during the judge call always wins.
 */
export async function maybeAutoReview(
  orch: StatusJudgeOrchestrator,
  taskId: string,
  deps: AutoReviewDeps = defaultDeps,
): Promise<AutoReviewResult> {
  if (!deps.enabled()) return "skipped"
  const task = orch.getTask(taskId)
  if (!task) return "skipped"
  // Field-only pre-gate before spawning git — turn-completes are frequent.
  if (!isReviewCandidate(task, true)) return "skipped"
  if (inFlight.has(taskId)) return "skipped"
  inFlight.add(taskId)
  try {
    const dirty = await deps.isDirty(task.worktreePath)
    if (!isReviewCandidate(task, dirty)) return "skipped"
    const finalMessage = await deps.lastAssistantText(task.worktreePath, task.vendor ?? DEFAULT_TASK_VENDOR)
    if (!finalMessage) return "skipped"
    if ((await deps.judge(finalMessage)) !== true) return "skipped"
    // User move wins: anything but in_progress now → abort silently.
    const fresh = orch.getTask(taskId)
    if (!fresh || fresh.archived || fresh.status !== "in_progress") return "skipped"
    await orch.setStatus(taskId, "in_review")
    return "moved"
  } finally {
    inFlight.delete(taskId)
  }
}
