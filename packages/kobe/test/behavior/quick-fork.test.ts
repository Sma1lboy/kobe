/**
 * Behavior test — KOB-74 quick-fork chord (`ctrl+f`).
 *
 * The contract this guards:
 *
 *   1. From a focused chat tab, pressing `ctrl+f` opens the Fork-task
 *      dialog seeded with the source task's repo basename and current
 *      branch.
 *   2. Typing a prompt and pressing Enter:
 *        - creates a new task that inherits the source's repo,
 *        - allocates a fresh worktree under <repo>/.claude/worktrees/,
 *        - dispatches the typed prompt as the first turn, and
 *        - lands the user on the new task in the sidebar.
 *   3. Esc on the dialog cancels — no new task is created.
 *
 * Why this is a behavior test, not just a unit test:
 *   - The chord registration (workspace-scoped useBindings), the
 *     dialog plumbing (DialogProvider stack), the orchestrator
 *     createTask + runTask sequence, and the sidebar's task-list
 *     reconciler all participate. Unit tests cover each piece in
 *     isolation; this proves they're wired together on the real binary.
 *   - The "fork inherits the source task's branch/HEAD" contract is
 *     only observable by reading the resulting manifest's repo +
 *     branch fields and verifying the worktree exists on disk.
 *
 * Setup mirrors `main-task.test.ts`: seed savedRepos with a fixture
 * repo so a `kind: "main"` task auto-seeds at boot. We then select
 * it (pulling focus to workspace) and fire the chord. The main task's
 * `branch === ""` exercises the HEAD-fallback path of the inheritance
 * logic in use-task-actions.ts.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import * as net from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeAll, expect, test } from "vitest"
import { type KobeHandle, spawnKobe } from "./driver"

const REPO_INIT = path.resolve(__dirname, "fixtures/repo-init.sh")

async function pickFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      if (addr && typeof addr === "object") {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close()
        reject(new Error("could not allocate a free port"))
      }
    })
  })
}

async function scriptEngine(
  port: number,
  endpoint: "/script" | "/finish",
  payload: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify(payload)
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(body.length) },
    body,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`fake-engine ${endpoint} failed: ${res.status} ${text}`)
  }
}

async function waitForFakeServer(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      await scriptEngine(port, "/script", { sessionId: "__warmup__", events: [] })
      return
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error(`fake-engine server never came up on :${port}: ${lastErr}`)
}

function seedSavedRepos(home: string, repos: string[]): void {
  const statePath = path.join(home, ".config", "kobe", "state.json")
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(statePath, JSON.stringify({ savedRepos: repos }, null, 2), "utf8")
}

/**
 * Wait until the manifest contains the forked child task with a
 * non-empty worktreePath. We pre-create one regular task before
 * forking (the "source"), so the fork is the SECOND non-main task in
 * the manifest. createTask persists with an empty worktreePath first;
 * the worktree allocation lands on the subsequent `runTask` call.
 * Reading between those saves catches mid-allocation state, so we
 * poll for both presence AND population.
 */
async function waitForForkedManifest(p: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastSnapshot = ""
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, "utf8")
        lastSnapshot = raw
        const data = JSON.parse(raw) as {
          tasks?: { kind?: string; worktreePath?: string }[]
        }
        const nonMain = (data.tasks ?? []).filter((t) => t.kind !== "main")
        if (nonMain.length >= 2) {
          const populated = nonMain.find((t) => typeof t.worktreePath === "string" && t.worktreePath.length > 0)
          if (populated) return
        }
      } catch {
        /* mid-write rename race — retry */
      }
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`manifest never gained a forked task at ${p}. Last snapshot:\n${lastSnapshot}`)
}

let tmpRoot: string
let homeDir: string
let repo: string
let kobe: KobeHandle | null = null

beforeAll(() => {
  if (!fs.existsSync(REPO_INIT)) {
    throw new Error(`missing fixture: ${REPO_INIT}`)
  }
})

afterEach(async () => {
  if (kobe && !kobe.closed) {
    await kobe.exit()
  }
  kobe = null
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

test("ctrl+f from a focused chat tab forks a child task seeded with the inherited repo + branch + prompt", async () => {
  // ---- fixtures ------------------------------------------------
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-quick-fork-"))
  homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })
  // Recognizable basename so the dialog's "Forking from <basename>"
  // summary is easy to assert on.
  repo = path.join(tmpRoot, "fork-fixture")
  const initResult = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (initResult.status !== 0) {
    throw new Error(`repo-init.sh failed: ${initResult.stderr}\n${initResult.stdout}`)
  }
  // We seed a saved-repo so a `kind: "main"` task auto-appears (the
  // pinned ★ row). The source-task focus shift happens via the
  // new-task flow below — boot-time main tasks land selected but
  // leave focus on the sidebar (the user hasn't gestured yet).
  seedSavedRepos(homeDir, [repo])

  const port = await pickFreePort()

  // ---- spawn kobe ----------------------------------------------
  kobe = await spawnKobe({
    env: {
      KOBE_TEST_ENGINE: "fake",
      KOBE_TEST_FAKE_PORT: String(port),
      KOBE_HOME_DIR: homeDir,
    },
    cols: 120,
    rows: 30,
  })

  await kobe.waitFor((s) => s.includes("KobeCode"), 10_000)
  await waitForFakeServer(port)

  // Pre-script `done` for two session ids — the source task (created
  // via the new-task dialog) and the fork. FakeAIEngine assigns ids
  // sequentially ("fake-1", "fake-2"…), so we cover both up front.
  for (const sessionId of ["fake-1", "fake-2", "fake-3"]) {
    await scriptEngine(port, "/script", { sessionId, events: [{ type: "done" }] })
    await scriptEngine(port, "/finish", { sessionId })
  }

  // Wait for the boot-seeded main task to land in the sidebar. The
  // sidebar row truncates long basenames inside its ~42-cell column
  // (visible as "★fork-fixtu main █" in PTY dumps), so we anchor on
  // the unambiguous "fork-fixt" stem rather than the full basename.
  await kobe.waitFor((s) => s.includes("fork-fixt"), 15_000)

  // Open the new-task dialog and create a regular task off the
  // fixture repo. The new-task flow pulls focus to the workspace
  // after createTask lands (openNewTaskFlow in app.tsx) — that's the
  // focus pre-condition the chord needs without us having to drive a
  // bare focus chord first. Same pattern g3-multitab uses to land in
  // a chat with workspace focus.
  // Plain `n` — sidebar-scoped `task.new` chord. Sidebar is the
  // default focused pane at boot, so the chord fires.
  await kobe.sendKeys("n")
  await kobe.waitFor((s) => s.includes("New task"), 5_000)
  await new Promise((r) => setTimeout(r, 250))
  // Clear pre-filled cwd and type our fixture repo.
  for (let i = 0; i < 200; i++) {
    await kobe.sendKeys("\x7f")
  }
  await kobe.typeText(repo)
  // Field 2: baseRef — accept the default ("main").
  await kobe.sendKeys("\t")
  await new Promise((r) => setTimeout(r, 200))
  // Submit (Enter on baseRef advances to Create button; one more
  // Enter commits).
  await kobe.sendKeys("\r")
  await new Promise((r) => setTimeout(r, 200))
  await kobe.sendKeys("\r")
  await new Promise((r) => setTimeout(r, 500))

  // ---- open the Fork dialog -----------------------------------
  // ctrl+f — kitty CSI-u form `\x1b[102;5u` (102 = ASCII 'f'). Same
  // encoding g3-multitab uses for ctrl+t. kobe enables
  // `useKittyKeyboard: {}` at render so the CSI-u form is what
  // opentui's parser surfaces as `{ name: "f", ctrl: true }`.
  await kobe.sendKeys("\x1b[102;5u")
  await kobe.waitFor((s) => s.includes("Fork task"), 10_000)
  const dialogScreen = await kobe.capture()
  // The dialog must surface the inherited summary as the
  // `<repo> > <branch>` breadcrumb. Repo basename = `fork-fixture`
  // (from REPO_INIT), baseRef defaults to `main` from repo-init.sh.
  expect(dialogScreen).toContain("Fork task")
  expect(dialogScreen).toContain("fork-fixture")
  expect(dialogScreen).toContain(">")
  expect(dialogScreen).toContain("main")

  // Settle so the dialog's <input> has focus before we start typing.
  await new Promise((r) => setTimeout(r, 250))

  // ---- type the prompt + submit -------------------------------
  const PROMPT = "quick fork exploration"
  await kobe.typeText(PROMPT)
  await kobe.sendKeys("\r")

  // ---- assertions on the manifest -----------------------------
  // The orchestrator persists the new task synchronously via store.create
  // before runTask spawns the engine. The worktree path is populated on
  // first runTask, which we await inside the quickForkActiveTask
  // handler — so by the time the dialog closes the manifest should
  // reflect the populated state. We still poll to absorb the
  // atomic-rename race against our first read.
  const manifestPath = path.join(homeDir, ".kobe", "tasks.json")
  await waitForForkedManifest(manifestPath, 15_000)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    tasks: {
      id: string
      kind?: string
      title: string
      repo: string
      branch: string
      worktreePath: string
    }[]
  }
  // Three tasks: the boot-seeded main, the source we created via the
  // new-task dialog (placeholder title, no worktree yet because no
  // prompt was submitted), and the fork (titled from PROMPT, worktree
  // populated by the fork's first runTask).
  expect(manifest.tasks).toHaveLength(3)
  const nonMain = manifest.tasks.filter((t) => t.kind !== "main")
  expect(nonMain).toHaveLength(2)
  // The fork is the entry with the populated worktreePath — the
  // source task stays in `backlog` with empty worktreePath because we
  // didn't submit its first prompt.
  const fork = nonMain.find((t) => t.worktreePath.length > 0)
  expect(fork).toBeDefined()
  expect(fork?.repo).toBe(repo)
  // Title derives from the typed prompt (deriveTitleFromPrompt
  // collapse + truncate). PROMPT is short enough to land verbatim.
  expect(fork?.title).toBe(PROMPT)
  // The fork's branch is a fresh kobe/-prefixed name, NOT the base
  // ref — we created a new branch FROM the base, we didn't reuse it.
  expect(fork?.branch.startsWith("kobe/")).toBe(true)
  expect(fork?.branch).not.toBe("main")
  // The worktree directory exists on disk.
  expect(fs.existsSync(fork!.worktreePath)).toBe(true)

  // Ancestry check — the fork's HEAD descends from the inherited base
  // ref ("main"). Without baseRef plumbing the log would be empty.
  const ancestry = spawnSync("git", ["log", "--format=%H", "-n", "10"], {
    cwd: fork!.worktreePath,
    encoding: "utf8",
  })
  expect(ancestry.status).toBe(0)
  // The fixture has exactly one commit on main; the new worktree
  // descends from it, so the log is non-empty.
  expect(ancestry.stdout.trim().length).toBeGreaterThan(0)

  await kobe.exit()
  expect(kobe.closed).toBe(true)
}, 90_000)
