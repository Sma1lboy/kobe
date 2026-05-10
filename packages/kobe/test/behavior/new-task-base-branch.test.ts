/**
 * Behavior test — new-task dialog "from branch" field roots the task's
 * branch at a non-default base ref.
 *
 * The contract this guards:
 *   - The dialog has THREE fields: prompt, repo path, from branch.
 *   - `tab` cycles through them in visible order.
 *   - The third field defaults to `main`. When the user types a
 *     different ref (a branch name in this test) and submits, the
 *     orchestrator passes it as `baseRef` to
 *     `git worktree add -b <new> <path> <baseRef>`.
 *   - The resulting worktree's HEAD descends from the chosen base
 *     ref, not from the source repo's currently-checked-out HEAD.
 *
 * Why this is a behavior test, not just a unit test:
 *   - The worktree.test.ts and core.test.ts cases assert the data
 *     plumbing. This test asserts the *user flow*: pressing tab the
 *     right number of times, typing the ref, hitting enter, and
 *     ending up with a worktree the user expects. A regression in
 *     the dialog (e.g. tab cycle skips a field, or enter on the
 *     `from branch` field doesn't commit) would silently fall back
 *     to "branch off whatever's checked out", which is a stealthy
 *     bug — that's the whole reason the field was added.
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

let tmpRoot: string
let repo: string
let homeDir: string
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

test("new-task dialog roots the task's branch at the chosen base ref", async () => {
  // ---- fixtures ------------------------------------------------
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-new-base-"))
  homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })
  repo = path.join(tmpRoot, "repo")
  const initResult = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (initResult.status !== 0) {
    throw new Error(`repo-init.sh failed: ${initResult.stderr}\n${initResult.stdout}`)
  }

  // Make a `release-base` branch with a distinct commit. The new
  // task will be rooted at it; we'll assert by checking that the
  // branch's signature file is present in the resulting worktree
  // (which it would NOT be if the orchestrator silently fell back
  // to main's HEAD).
  spawnSync("git", ["checkout", "-b", "release-base"], { cwd: repo })
  fs.writeFileSync(path.join(repo, "RELEASE.md"), "release base\n")
  spawnSync("git", ["add", "RELEASE.md"], { cwd: repo })
  spawnSync("git", ["commit", "-m", "release base commit"], { cwd: repo })
  const releaseSha = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).stdout.trim()
  // Switch back to main so `release-base` is genuinely a non-HEAD
  // ref — without baseRef plumbing, the new worktree would inherit
  // main's HEAD and lack RELEASE.md.
  spawnSync("git", ["checkout", "main"], { cwd: repo })

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

  await kobe.waitFor((s) => s.includes("kobe"), 10_000)
  await waitForFakeServer(port)

  // The new-task flow auto-submits the prompt to the engine. Pre-
  // script `done` so the pump exits cleanly and the test doesn't
  // have a hung engine pinning resources.
  await scriptEngine(port, "/script", {
    sessionId: "fake-1",
    events: [{ type: "done" }],
  })
  await scriptEngine(port, "/finish", { sessionId: "fake-1" })

  // ---- open new-task dialog -----------------------------------
  await kobe.sendKeys("\x0e") // ctrl+n
  await kobe.waitFor((s) => s.includes("New task"), 5_000)
  // The "from branch" label confirms the third field exists; if
  // someone removes it, this assertion catches the regression in
  // a single line.
  await kobe.waitFor((s) => s.includes("from branch"), 5_000)
  // Extra settle so the prompt input has its focused listener
  // attached before we start typing — without this, the very first
  // character can race with the input's stdin attach.
  await new Promise((r) => setTimeout(r, 250))
  // Belt-and-suspenders: clear any spurious keystrokes that may have
  // landed in the prompt before focus settled (e.g. the `n` that
  // triggered the dialog itself can leak through if the chat
  // composer's input was the previously-focused renderable). The
  // prompt input starts empty by design, so backspaces are no-ops
  // when the field is genuinely empty.
  for (let i = 0; i < 4; i++) {
    await kobe.sendKeys("\x7f")
  }

  // ---- fill in fields -----------------------------------------
  // Field 1: prompt.
  const TITLE = "based-on-release"
  await kobe.typeText(TITLE)

  // Field 2: repo (replace the cwd default with our fixture).
  await kobe.sendKeys("\t")
  for (let i = 0; i < 200; i++) {
    await kobe.sendKeys("\x7f")
  }
  await kobe.typeText(repo)

  // Field 3: from branch. Tab from repo to baseRef. The default
  // value is `main` — clear it and type the release-base ref.
  await kobe.sendKeys("\t")
  // Settle so the focus transfer reconciles before we send the
  // backspaces (Solid's `focused` prop changes are reflected in the
  // next render; without this beat the keys may race and land in
  // the previous input).
  await new Promise((r) => setTimeout(r, 250))
  for (let i = 0; i < 32; i++) {
    await kobe.sendKeys("\x7f")
  }
  await kobe.typeText("release-base")

  // Submit. Enter on the baseRef field commits unconditionally
  // (when prompt + repo are filled).
  await kobe.sendKeys("\r")

  // Sidebar reflects the new task.
  await kobe.waitFor((s) => s.includes(TITLE), 15_000)

  // ---- assertions ---------------------------------------------
  // Read the manifest the orchestrator just persisted, find the
  // task's worktree, then verify the worktree's HEAD descends
  // from the release-base SHA. This is the only way to prove
  // the baseRef was actually plumbed through git — the branch
  // name itself is `kobe/<slug>-<suffix>`, distinct from the
  // base ref name.
  //
  // `createTask` does two saves (placeholder + finalized). Wait
  // for the populated state before reading, otherwise the test
  // races against an empty worktreePath and the `fs.existsSync`
  // assertion below intermittently fails.
  const manifestPath = path.join(homeDir, ".kobe", "tasks.json")
  await waitForManifestPopulated(manifestPath, 15_000)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    tasks: { id: string; worktreePath: string; branch: string }[]
  }
  expect(manifest.tasks).toHaveLength(1)
  const created = manifest.tasks[0]!
  expect(fs.existsSync(created.worktreePath)).toBe(true)

  // The release-base file is checked out — wouldn't be present
  // if the worktree were rooted at main.
  expect(fs.existsSync(path.join(created.worktreePath, "RELEASE.md"))).toBe(true)

  // Ancestry: the new branch's HEAD descends from release-base.
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", releaseSha, "HEAD"], {
    cwd: created.worktreePath,
  })
  expect(ancestry.status).toBe(0)

  // The task's branch is on a kobe/-prefixed name (NOT
  // release-base) — we created a *new* branch FROM the base, we
  // didn't reuse the base.
  expect(created.branch.startsWith("kobe/")).toBe(true)
  expect(created.branch).not.toBe("release-base")

  await kobe.exit()
  expect(kobe.closed).toBe(true)
}, 90_000)

/**
 * Wait until the manifest exists AND the first task's worktreePath
 * is populated. The orchestrator does two saves on createTask
 * (placeholder + finalized); reading between them captures a stale
 * half-state with empty branch / worktreePath, which races against
 * the on-disk worktree's actual existence.
 */
async function waitForManifestPopulated(p: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, "utf8")
        const data = JSON.parse(raw) as {
          tasks?: { worktreePath?: string }[]
        }
        const t = data.tasks?.[0]
        if (t && typeof t.worktreePath === "string" && t.worktreePath.length > 0) {
          return
        }
      } catch {
        // Manifest in mid-write (rename race) — try again.
      }
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`manifest never reached populated state at ${p}`)
}
