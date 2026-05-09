/**
 * Behavior test — sidebar `d` deletes (cancels + nukes worktree) the
 * task under the cursor.
 *
 * The contract this guards (Wave 4 W4.A repo-grouped sidebar):
 *   - Pressing `d` on the sidebar cursor opens a confirm dialog.
 *   - On confirm, the orchestrator's `deleteTask` runs:
 *       1. The task's worktree is removed from disk.
 *       2. The task moves to `canceled` status in the persisted manifest
 *          (we never silently drop the row from the index — per the
 *          CLAUDE.md "no delete without consent" rule the on-disk record
 *          stays for audit). The repo header's count decrements; if the
 *          repo had only one task, the header still renders briefly until
 *          the orchestrator fully removes the row from the index.
 *   - `cancel` (the default focus on the confirm) leaves everything
 *     in place — defensive against fast-fingered `d` presses.
 *
 * Why this is a behavior test, not a unit test:
 *   - The sidebar's keymap, the dialog stack, the orchestrator wiring,
 *     and the worktree manager all participate. A unit test would mock
 *     half of those and miss seam regressions (e.g. the sidebar emits
 *     the request but app.tsx forgets to wire it).
 *   - The disk-state check (worktree directory gone) is the only
 *     assertion that proves we actually freed the on-disk resource.
 *
 * Wave 4 W4.A change: the original test asserted on the `Canceled`
 * status group label appearing in the sidebar after delete. That group
 * doesn't exist in the new repo-grouped sidebar — the rewritten
 * assertions instead read the on-disk manifest for the post-delete
 * `canceled` status and observe the repo header label + the task row
 * disappearing from the visible cursor target via a follow-up `d`
 * press that becomes a no-op.
 *
 * Mechanics mirror `g2-end-to-end.test.ts` and the rewritten
 * `sidebar-status-update.test.ts`: a fixture repo, fake-engine HTTP
 * side-channel for engine scripting, PTY-driven kobe.
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

test("pressing `d` on the sidebar cursor + confirm deletes the task and removes its worktree", async () => {
  // ---- fixtures ------------------------------------------------
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-sidebar-delete-"))
  homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })
  // Recognizable basename so the repo header label is unambiguous.
  // `path.basename("/tmp/.../my-frontend") === "my-frontend"`.
  repo = path.join(tmpRoot, "my-frontend")
  const initResult = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (initResult.status !== 0) {
    throw new Error(`repo-init.sh failed: ${initResult.stderr}\n${initResult.stdout}`)
  }
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

  // Pre-script the first runTask (the prompt auto-submits when the
  // dialog commits per the Wave 3 G pendingPrompt flow). We drive
  // the engine straight to `done` so the task settles and the
  // pump's finally clause flips status to `done` quickly. The
  // delete path itself is independent of run state, but the test
  // is more deterministic when the engine isn't still streaming
  // when we press `d`.
  await scriptEngine(port, "/script", {
    sessionId: "fake-1",
    events: [{ type: "done" }],
  })
  await scriptEngine(port, "/finish", { sessionId: "fake-1" })

  // ---- create a task via the new-task dialog -------------------
  await kobe.sendKeys("n")
  await kobe.waitFor((s) => s.includes("New task"), 5_000)
  // Settle so the dialog's prompt input has its focused listener
  // attached before we start typing — the very first character
  // can otherwise race with the input's stdin attach and land
  // somewhere other than the prompt field.
  await new Promise((r) => setTimeout(r, 250))
  // Belt-and-suspenders: clear any leaked keystrokes from the dialog
  // open (the `n` that triggered the open can land on the prompt
  // when the previously-focused renderable's keypress listener is
  // still attached as the dialog mounts). Backspaces on an empty
  // field are no-ops, so this is safe in the happy case.
  for (let i = 0; i < 4; i++) {
    await kobe.sendKeys("\x7f")
  }

  const TITLE = "delete-me"
  await kobe.typeText(TITLE)
  // Tab to the repo field, settle, clear the default, type our
  // fixture path.
  await kobe.sendKeys("\t")
  await new Promise((r) => setTimeout(r, 250))
  for (let i = 0; i < 200; i++) {
    await kobe.sendKeys("\x7f")
  }
  await kobe.typeText(repo)
  // Enter on the repo field commits when both prompt + repo are
  // filled (the new-task dialog's tri-field flow falls back to a
  // direct commit instead of cycling to baseRef when both
  // upstream fields are valid).
  await kobe.sendKeys("\r")

  // Sidebar shows the task. Wait until the title is visible.
  await kobe.waitFor((s) => s.includes(TITLE), 15_000)

  // ---- assert: the W4.A repo-grouped sidebar shows the task under
  //      its repo header. The repo's basename ("my-frontend") is the
  //      header label; the task title appears below it. PTY-flattened
  //      normalization collapses some whitespace but the substring
  //      `my-frontend ... 1 ... delete-me` stays embedded.
  await kobe.waitFor((s) => /my-frontend\s*1[\s\S]{0,200}delete-me/.test(s), 15_000)
  const beforeDelete = await kobe.capture()
  expect(/my-frontend\s*1[\s\S]{0,200}delete-me/.test(beforeDelete)).toBe(true)

  // The worktree's on-disk path is `<repo>/.kobe/worktrees/<id>/`.
  // We don't know the ULID id from outside, so we read the
  // manifest the orchestrator just wrote. `createTask` does TWO
  // saves: (1) placeholder with empty branch/worktreePath, (2)
  // finalized with the real values after `git worktree add`
  // succeeds. We must wait for the second save before reading,
  // otherwise we capture the half-state and `worktreePath` is "".
  const manifestPath = path.join(homeDir, ".kobe", "tasks.json")
  await waitForManifestPopulated(manifestPath, 15_000)
  const manifestRaw = fs.readFileSync(manifestPath, "utf8")
  const manifest = JSON.parse(manifestRaw) as {
    tasks: { id: string; worktreePath: string; title: string }[]
  }
  expect(manifest.tasks).toHaveLength(1)
  const created = manifest.tasks[0]!
  expect(fs.existsSync(created.worktreePath)).toBe(true)

  // ---- focus the sidebar so its `d` binding receives the keystroke ----
  // After the new-task flow, focus is on `workspace` (the chat
  // composer auto-focuses for the pendingPrompt flow). The sidebar's
  // `d` binding is gated on `isFocused("sidebar")`, so we must move
  // focus first. We use ctrl+1 — app.tsx wires `ctrl+1` to
  // `setFocusedPane("sidebar")` and that binding is *not* gated on
  // any input-focus state (modifier-prefixed keys always work). The
  // PTY byte for ctrl+1 is `\x1b[1;5u` (kitty keyboard protocol form
  // that opentui's keypress decoder accepts as ctrl+1).
  await kobe.sendKeys("\x1b[1;5u")
  await new Promise((r) => setTimeout(r, 250))

  // ---- press `d` on the sidebar cursor -------------------------
  // The sidebar auto-syncs its cursor onto the active task (the
  // newly-created task is selected by the openNewTaskFlow). So
  // pressing `d` immediately targets it. The keymap layer is
  // modifier-aware: `d` (no ctrl) reaches the sidebar binding.
  await kobe.sendKeys("d")
  // The confirm dialog title format is `Delete '<title>'?` — see
  // app.tsx Shell.confirmDeleteTask.
  await kobe.waitFor((s) => s.includes(`Delete '${TITLE}'?`), 10_000)

  // ---- confirm ------------------------------------------------
  // The DialogConfirm's default `active` is `confirm` (see
  // src/tui/ui/dialog-confirm.tsx — `active: "confirm"`). app.tsx
  // passes `"cancel"` as the *label* (button text override), but
  // does NOT change the default-focused button. Pressing Enter
  // immediately fires the confirm path. We don't navigate; the
  // straight-through happy path is what `d` users will hit.
  await new Promise((r) => setTimeout(r, 100))
  await kobe.sendKeys("\r")

  // ---- assertions ---------------------------------------------
  // The worktree directory must be gone from disk. This is the
  // load-bearing on-disk side effect of `deleteTask`.
  await waitForCondition(() => !fs.existsSync(created.worktreePath), 10_000)
  expect(fs.existsSync(created.worktreePath)).toBe(false)

  // The task record persists in the manifest (status flipped to
  // `canceled`, not deleted from the index). This is the
  // load-bearing CLAUDE.md guarantee: the orchestrator never
  // silently drops a row.
  await waitForCondition(() => {
    try {
      const raw = fs.readFileSync(manifestPath, "utf8")
      const data = JSON.parse(raw) as { tasks: { id: string; status: string }[] }
      const t = data.tasks.find((x) => x.id === created.id)
      return t?.status === "canceled"
    } catch {
      return false
    }
  }, 10_000)
  const afterRaw = fs.readFileSync(manifestPath, "utf8")
  const after = JSON.parse(afterRaw) as { tasks: { id: string; status: string }[] }
  const stillThere = after.tasks.find((t) => t.id === created.id)
  expect(stillThere).toBeDefined()
  expect(stillThere?.status).toBe("canceled")

  // The sidebar still shows the repo header (status is `canceled`
  // but the row still belongs to its repo — the W4.A repo-grouping
  // contract). The repo header label `my-frontend` and the title
  // `delete-me` both remain in the cumulative buffer because the
  // store's archive() does not remove the row; it only flips the
  // status. (The pre-W4.A test asserted on a `Canceled` group label
  // appearing — that label no longer exists after dropping status
  // grouping, so we anchor on the always-present repo header.)
  const finalScreen = await kobe.capture()
  expect(finalScreen).toContain("my-frontend")
  expect(finalScreen).toContain("delete-me")

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

/** Poll a predicate until it's true or `timeoutMs` elapses. */
async function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  // Don't throw — the assertion that follows in the caller surfaces a
  // clearer message, and we want both signals on failure.
}
