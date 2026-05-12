#!/usr/bin/env bun
/**
 * Seed a self-contained mock environment for `bun run dev:test`.
 *
 * Idea: re-roots `KOBE_HOME_DIR` at `<workspace>/.dev-fixture/home/` so
 * every persistent surface kobe touches (tasks.json, savedRepos KV,
 * Claude Code's `~/.claude/projects/<cwd>/<sid>.jsonl` history files)
 * lives inside the fixture, and pre-populates it with a representative
 * mix of state so the TUI has something to render the moment it boots:
 *
 *   - 2 fake git repos under `<root>/repos/` (one dirty, one clean) so
 *     the file tree + preview pane have actual `git status`/`git diff`
 *     surfaces to display.
 *   - Both repos registered as savedRepos so a "main" pinned task per
 *     repo shows in the sidebar (KOB-15).
 *   - A handful of regular tasks across every TaskStatus — backlog,
 *     in_progress, in_review, done, error — plus pinned + archived
 *     variants. Two of them have real `git worktree add`'d worktrees
 *     so opening them exercises the per-worktree code paths.
 *   - JSONL chat-history files for tasks that own a sessionId, so the
 *     chat pane has prior assistant/user turns to render on selection.
 *
 * Pair this with `KOBE_TEST_ENGINE=dev-fake` (see app.tsx) which spins
 * up an in-process `DevAIEngine` that auto-replies with canned events
 * — so `<enter>` in the composer actually does something instead of
 * hanging waiting for the real `claude` binary.
 *
 * Idempotent: a second run without `--reset` is a no-op once the
 * fixture exists. `--reset` wipes the whole `.dev-fixture/` tree first.
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { encodeCwd } from "../src/engine/claude-code-local/history.ts"
import { ulid } from "../src/orchestrator/index/ulid.ts"
import type { Task, TaskIndex } from "../src/types/task.ts"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const ROOT = resolve(__dirname, "..", ".dev-fixture")
const HOME = join(ROOT, "home")
const KOBE_DIR = join(HOME, ".kobe")
const KV_PATH = join(HOME, ".config", "kobe", "state.json")
const CLAUDE_PROJECTS = join(HOME, ".claude", "projects")
const REPOS_ROOT = join(ROOT, "repos")

const reset = process.argv.includes("--reset")

function main(): void {
  if (reset && existsSync(ROOT)) {
    rmSync(ROOT, { recursive: true, force: true })
  }
  if (existsSync(join(KOBE_DIR, "tasks.json")) && !reset) {
    console.log(`dev fixture already seeded at ${ROOT}`)
    console.log("  re-run with --reset to rebuild from scratch")
    printEnvHints()
    return
  }

  mkdirSync(KOBE_DIR, { recursive: true })
  mkdirSync(dirname(KV_PATH), { recursive: true })
  mkdirSync(CLAUDE_PROJECTS, { recursive: true })
  mkdirSync(REPOS_ROOT, { recursive: true })

  const repoAlpha = initRepo("kobe-demo-alpha", {
    files: {
      "README.md": "# kobe-demo-alpha\n\nDemo repo seeded by dev-fixture.\n",
      "src/index.ts": "export const greet = (name: string) => `hi, ${name}`\n",
      "src/util.ts": "export const add = (a: number, b: number) => a + b\n",
      "package.json": `${JSON.stringify({ name: "kobe-demo-alpha", version: "0.0.1" }, null, 2)}\n`,
    },
    dirty: {
      "src/index.ts": "export const greet = (name: string) => `hello, ${name}!`\n",
      "src/new-feature.ts": "// untracked draft from a dev:test run\nexport const flag = true\n",
    },
  })

  const repoBeta = initRepo("kobe-demo-beta", {
    files: {
      "README.md": "# kobe-demo-beta\n\nSecond demo repo. Clean working tree.\n",
      "main.py": "def main():\n    print('hello from beta')\n\n\nif __name__ == '__main__':\n    main()\n",
      "lib/helpers.py": "def shout(s: str) -> str:\n    return s.upper()\n",
    },
  })

  // Real worktrees for the in_progress / in_review demo tasks. Created
  // up-front so opening them in the file-tree / preview pane shows real
  // git output.
  const wtInProgressId = ulid()
  const wtInReviewId = ulid()
  const wtInProgress = join(repoAlpha, ".claude/worktrees", wtInProgressId)
  const wtInReview = join(repoAlpha, ".claude/worktrees", wtInReviewId)
  gitWorktreeAdd(repoAlpha, wtInProgress, "kobe/feat/streaming-ui")
  writeFileSync(join(wtInProgress, "src/streaming.ts"), "// scratch work in progress\nexport const stream = () => {}\n")
  // leave the file untracked so the file tree shows `?`
  gitWorktreeAdd(repoAlpha, wtInReview, "kobe/fix/sidebar-flicker")
  spawnSync("git", ["commit", "--allow-empty", "-m", "wip: smoothing flicker"], { cwd: wtInReview, stdio: "ignore" })

  const now = Date.now()
  const iso = (offsetMin: number) => new Date(now + offsetMin * 60_000).toISOString()

  const tasks: Task[] = []

  // Two main (pinned-per-repo) tasks. Created via the save flow normally;
  // here we synthesise the same shape ensureMainTask would have produced.
  tasks.push(
    mainTask({ repo: repoAlpha, createdAt: iso(-60 * 24 * 7) }),
    mainTask({ repo: repoBeta, createdAt: iso(-60 * 24 * 5) }),
  )

  const sessions = new Map<string, { cwd: string; messages: ClaudeJsonlRecord[] }>()
  const fakeSessionId = (): string => crypto.randomUUID()

  // in_progress task with chat history + a real worktree
  {
    const sid = fakeSessionId()
    const tabId = ulid()
    const taskId = ulid()
    sessions.set(sid, {
      cwd: wtInProgress,
      messages: cannedConversation(sid, [
        { role: "user", text: "Add a streaming UI to the chat pane." },
        {
          role: "assistant",
          text: "I'll start by inspecting the existing Chat component, then add a streaming text wrapper around the assistant message renderer.",
        },
        { role: "user", text: "Sounds good. Use a Solid signal for the stream buffer." },
        {
          role: "assistant",
          text: "Done. Created `src/streaming.ts` with the buffer signal and wired it into `MessageList`.",
        },
      ]),
    })
    tasks.push({
      id: taskIdT(taskId),
      title: "Streaming UI for chat pane",
      repo: repoAlpha,
      branch: "kobe/feat/streaming-ui",
      worktreePath: wtInProgress,
      kind: "task",
      sessionId: sid,
      tabs: [{ id: tabId, sessionId: sid, seq: 1, createdAt: iso(-30) }],
      activeTabId: tabId,
      status: "in_progress",
      archived: false,
      pinned: true,
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      createdAt: iso(-45),
      updatedAt: iso(-2),
    })
  }

  // in_review task with a clean worktree + smaller history
  {
    const sid = fakeSessionId()
    const tabId = ulid()
    const taskId = ulid()
    sessions.set(sid, {
      cwd: wtInReview,
      messages: cannedConversation(sid, [
        { role: "user", text: "Sidebar flickers when statuses update — investigate." },
        {
          role: "assistant",
          text: "Reproduced. The flicker is from re-creating the For-loop key on every signal tick. Patch incoming.",
        },
      ]),
    })
    tasks.push({
      id: taskIdT(taskId),
      title: "Fix sidebar flicker on status update",
      repo: repoAlpha,
      branch: "kobe/fix/sidebar-flicker",
      worktreePath: wtInReview,
      kind: "task",
      sessionId: sid,
      tabs: [{ id: tabId, sessionId: sid, seq: 1, createdAt: iso(-120) }],
      activeTabId: tabId,
      status: "in_review",
      archived: false,
      pinned: false,
      permissionMode: "default",
      model: "claude-opus-4-7",
      createdAt: iso(-180),
      updatedAt: iso(-15),
    })
  }

  // Backlog task — lazy worktree (worktreePath empty)
  {
    const tabId = ulid()
    const taskId = ulid()
    tasks.push({
      id: taskIdT(taskId),
      title: "Wire diff stats to file tree",
      repo: repoAlpha,
      branch: "",
      worktreePath: "",
      kind: "task",
      sessionId: null,
      tabs: [{ id: tabId, sessionId: null, seq: 1, createdAt: iso(-5) }],
      activeTabId: tabId,
      status: "backlog",
      archived: false,
      createdAt: iso(-5),
      updatedAt: iso(-5),
    })
  }

  // Done task — completed work, sessionId still resolves to history
  {
    const sid = fakeSessionId()
    const tabId = ulid()
    const taskId = ulid()
    sessions.set(sid, {
      cwd: repoBeta,
      messages: cannedConversation(sid, [
        { role: "user", text: "Add a shout helper that uppercases input." },
        { role: "assistant", text: "Added `lib/helpers.py:shout`. Returns `s.upper()`." },
      ]),
    })
    tasks.push({
      id: taskIdT(taskId),
      title: "Add shout helper",
      repo: repoBeta,
      branch: "kobe/feat/shout-helper",
      worktreePath: repoBeta, // pretend it landed back on main
      kind: "task",
      sessionId: sid,
      tabs: [{ id: tabId, sessionId: sid, seq: 1, createdAt: iso(-60 * 24) }],
      activeTabId: tabId,
      status: "done",
      archived: false,
      createdAt: iso(-60 * 24 * 2),
      updatedAt: iso(-60 * 24),
    })
  }

  // Error task — surfaces the error styling in the sidebar
  {
    const tabId = ulid()
    const taskId = ulid()
    tasks.push({
      id: taskIdT(taskId),
      title: "Refactor preview key handler",
      repo: repoBeta,
      branch: "kobe/refactor/preview-keys",
      worktreePath: "",
      kind: "task",
      sessionId: null,
      tabs: [{ id: tabId, sessionId: null, seq: 1, createdAt: iso(-300) }],
      activeTabId: tabId,
      status: "error",
      archived: false,
      createdAt: iso(-360),
      updatedAt: iso(-300),
    })
  }

  // Archived done task — lives in the Archives view ([ / ] toggles)
  {
    const sid = fakeSessionId()
    const tabId = ulid()
    const taskId = ulid()
    sessions.set(sid, {
      cwd: repoAlpha,
      messages: cannedConversation(sid, [
        { role: "user", text: "Bump version in package.json." },
        { role: "assistant", text: "Bumped to 0.0.1. Want me to add a changelog entry too?" },
      ]),
    })
    tasks.push({
      id: taskIdT(taskId),
      title: "Bump alpha to 0.0.1",
      repo: repoAlpha,
      branch: "kobe/chore/bump",
      worktreePath: repoAlpha,
      kind: "task",
      sessionId: sid,
      tabs: [{ id: tabId, sessionId: sid, seq: 1, createdAt: iso(-60 * 24 * 14) }],
      activeTabId: tabId,
      status: "done",
      archived: true,
      createdAt: iso(-60 * 24 * 14),
      updatedAt: iso(-60 * 24 * 13),
    })
  }

  // Archived canceled task — make sure cancel state renders in archives too
  {
    const tabId = ulid()
    const taskId = ulid()
    tasks.push({
      id: taskIdT(taskId),
      title: "Investigate flaky test (abandoned)",
      repo: repoBeta,
      branch: "",
      worktreePath: "",
      kind: "task",
      sessionId: null,
      tabs: [{ id: tabId, sessionId: null, seq: 1, createdAt: iso(-60 * 24 * 30) }],
      activeTabId: tabId,
      status: "canceled",
      archived: true,
      createdAt: iso(-60 * 24 * 30),
      updatedAt: iso(-60 * 24 * 29),
    })
  }

  // Multi-tab task to exercise the chat tab strip
  {
    const sid1 = fakeSessionId()
    const sid2 = fakeSessionId()
    const tab1 = ulid()
    const tab2 = ulid()
    const taskId = ulid()
    sessions.set(sid1, {
      cwd: repoBeta,
      messages: cannedConversation(sid1, [
        { role: "user", text: "Sketch a CLI for the helpers module." },
        { role: "assistant", text: "Here's a tiny argparse skeleton — want me to commit it?" },
      ]),
    })
    sessions.set(sid2, {
      cwd: repoBeta,
      messages: cannedConversation(sid2, [
        { role: "user", text: "On second thought, prototype it as a Click app instead." },
        { role: "assistant", text: "Switched to Click. Same interface, nicer help output." },
      ]),
    })
    tasks.push({
      id: taskIdT(taskId),
      title: "Helpers CLI exploration",
      repo: repoBeta,
      branch: "kobe/feat/helpers-cli",
      worktreePath: repoBeta,
      kind: "task",
      sessionId: sid1,
      tabs: [
        { id: tab1, sessionId: sid1, seq: 1, title: "argparse", createdAt: iso(-200) },
        { id: tab2, sessionId: sid2, seq: 2, title: "click", createdAt: iso(-90) },
      ],
      activeTabId: tab2,
      status: "in_progress",
      archived: false,
      createdAt: iso(-200),
      updatedAt: iso(-30),
    })
  }

  // Plan-mode task to demo the ribbon
  {
    const tabId = ulid()
    const taskId = ulid()
    tasks.push({
      id: taskIdT(taskId),
      title: "Plan: refactor orchestrator core",
      repo: repoAlpha,
      branch: "",
      worktreePath: "",
      kind: "task",
      sessionId: null,
      tabs: [{ id: tabId, sessionId: null, seq: 1, createdAt: iso(-10) }],
      activeTabId: tabId,
      status: "backlog",
      archived: false,
      permissionMode: "plan",
      createdAt: iso(-10),
      updatedAt: iso(-10),
    })
  }

  const index: TaskIndex = { version: 2, tasks }
  writeJsonAtomic(join(KOBE_DIR, "tasks.json"), index)
  writeJsonAtomic(KV_PATH, { savedRepos: [repoAlpha, repoBeta] })

  for (const [sessionId, { cwd, messages }] of sessions) {
    const dir = join(CLAUDE_PROJECTS, encodeCwd(cwd))
    mkdirSync(dir, { recursive: true })
    const lines = `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines, "utf8")
  }

  console.log(`✓ dev fixture seeded at ${ROOT}`)
  console.log(`  ${tasks.length} tasks, ${sessions.size} session histories`)
  console.log(`  repos: ${repoAlpha}`)
  console.log(`         ${repoBeta}`)
  printEnvHints()
}

function printEnvHints(): void {
  console.log("")
  console.log(`  KOBE_HOME_DIR=${HOME}`)
  console.log("  KOBE_TEST_ENGINE=dev-fake")
}

/* ---------------- helpers ---------------- */

function taskIdT(id: string): Task["id"] {
  return id as Task["id"]
}

interface RepoSpec {
  files: Record<string, string>
  /** Optional unstaged modifications + untracked additions to leave in the working tree. */
  dirty?: Record<string, string>
}

function initRepo(name: string, spec: RepoSpec): string {
  const dir = join(REPOS_ROOT, name)
  mkdirSync(dir, { recursive: true })
  run(["git", "init", "--quiet", "--initial-branch=main"], dir)
  run(["git", "config", "user.email", "dev@kobe.test"], dir)
  run(["git", "config", "user.name", "kobe dev fixture"], dir)
  run(["git", "config", "commit.gpgsign", "false"], dir)
  for (const [rel, content] of Object.entries(spec.files)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, "utf8")
  }
  run(["git", "add", "."], dir)
  run(["git", "commit", "--quiet", "-m", "init: dev fixture"], dir)
  if (spec.dirty) {
    for (const [rel, content] of Object.entries(spec.dirty)) {
      const abs = join(dir, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content, "utf8")
    }
  }
  return dir
}

function gitWorktreeAdd(repo: string, worktreePath: string, branch: string): void {
  mkdirSync(dirname(worktreePath), { recursive: true })
  run(["git", "worktree", "add", "-b", branch, worktreePath], repo)
}

function run(cmd: string[], cwd: string): void {
  const [bin, ...args] = cmd
  if (!bin) throw new Error("run(): empty command")
  const res = spawnSync(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
  if (res.status !== 0) {
    const stderr = res.stderr?.toString() ?? ""
    const stdout = res.stdout?.toString() ?? ""
    throw new Error(`${cmd.join(" ")} (cwd=${cwd}) exited ${res.status}\n${stderr}${stdout}`)
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  // node:fs renameSync — bun supports it
  spawnSync("mv", [tmp, path], { stdio: "ignore" })
}

interface ClaudeJsonlRecord {
  type: "user" | "assistant"
  message: { role: "user" | "assistant"; content: string }
  timestamp: string
  sessionId: string
  cwd?: string
  uuid?: string
}

function cannedConversation(
  sessionId: string,
  turns: ReadonlyArray<{ role: "user" | "assistant"; text: string }>,
): ClaudeJsonlRecord[] {
  const start = Date.now() - turns.length * 60_000
  return turns.map((t, i) => ({
    type: t.role,
    message: { role: t.role, content: t.text },
    timestamp: new Date(start + i * 30_000).toISOString(),
    sessionId,
    uuid: crypto.randomUUID(),
  }))
}

function mainTask(args: { repo: string; createdAt: string }): Task {
  const taskId = ulid()
  const tabId = ulid()
  return {
    id: taskIdT(taskId),
    title: args.repo.split("/").pop() ?? "main",
    repo: args.repo,
    branch: "",
    worktreePath: args.repo,
    kind: "main",
    sessionId: null,
    tabs: [{ id: tabId, sessionId: null, seq: 1, createdAt: args.createdAt }],
    activeTabId: tabId,
    status: "backlog",
    archived: false,
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
  }
}

main()
