/**
 * Sprint-6 (KOB-218) end-to-end behavior test. Drives the full
 * bootstrap → daemon → tmux wire against a real tmux server and a fake
 * `claude` binary that creates a JSONL in `~/.claude/projects/...` so
 * the session-id sniff has something real to find.
 *
 * Gated on tmux availability (mirrors `tmux-pane-swap.test.ts`). The
 * fake claude is installed under a per-test `bin/claude` and prepended
 * to PATH so `findClaudeBinary()` inside the daemon resolves to it
 * without needing to touch the user's real `claude` install.
 *
 * Cleanup: `afterEach` kills the tmux session via the plain CLI so an
 * assertion failure never leaks an orphaned tmux server, and tears down
 * the daemon socket.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { KobeDaemonClient } from "../../src/client/index.ts"
import { fallbackTestSocketPath } from "../../src/daemon/paths.ts"
import { type DaemonServer, startDaemonServer } from "../../src/daemon/server.ts"
import { Orchestrator } from "../../src/orchestrator/core.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import { MetadataSuggester } from "../../src/orchestrator/metadata-suggester.ts"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"
import {
  DEFAULT_PLACEHOLDERS,
  type LayoutStep,
  type PaneLabel,
  buildLayoutSteps,
  placeholderShellCommand,
} from "../../src/tmux/layout.ts"
import { FakeAIEngine } from "./fake-engine.ts"

const REPO_INIT = path.resolve(__dirname, "./fixtures/repo-init.sh")
const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0

class NoopMetadataSuggester extends MetadataSuggester {
  override async suggestBranchSlug(): Promise<string | null> {
    return null
  }
  override async suggestTitle(): Promise<string | null> {
    return null
  }
  override async suggestWorktreeSlug(): Promise<string | null> {
    return null
  }
}

let tmpRoot = ""
let homeDir = ""
let repo = ""
let session = ""
let binDir = ""
let socketPath = ""
let pidPath = ""
let server: DaemonServer | null = null
let orch: Orchestrator | null = null
let originalPath = ""
let originalHome: string | undefined
let originalTmuxTmpdir: string | undefined

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-sprint6-"))
  homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(path.join(homeDir, ".claude", "projects"), { recursive: true })
  repo = path.join(tmpRoot, "repo")
  binDir = path.join(tmpRoot, "bin")
  fs.mkdirSync(binDir, { recursive: true })
  const fakeClaude = path.join(binDir, "claude")
  // The fake encodes its cwd the same way as `encodeCwd` (every `/` and
  // `.` → `-`) and drops a `<uuid>.jsonl` into the matching project
  // dir before blocking forever. That's exactly what the daemon's
  // sniff path looks for.
  fs.writeFileSync(
    fakeClaude,
    `#!/bin/bash
encoded_cwd=$(printf '%s' "$PWD" | sed 's|[/.]|-|g')
project_dir="$HOME/.claude/projects/$encoded_cwd"
mkdir -p "$project_dir"
sid=$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z')
if [ -z "$sid" ]; then sid="fake-$$-$RANDOM"; fi
touch "$project_dir/$sid.jsonl"
exec sleep 60
`,
    { mode: 0o755 },
  )
  originalPath = process.env.PATH ?? ""
  originalHome = process.env.HOME
  originalTmuxTmpdir = process.env.TMUX_TMPDIR
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`
  process.env.HOME = homeDir
  // Force a fresh per-test tmux server. Without this, an existing
  // user tmux server (very common on dev laptops) reuses its first-
  // start HOME, and the fake claude inside spawned panes writes its
  // JSONL into the wrong project dir — the daemon sniffs the right
  // dir but finds nothing, so `setTabSessionId` is never called.
  const tmuxTmpdir = path.join(tmpRoot, "tmux")
  fs.mkdirSync(tmuxTmpdir, { recursive: true })
  process.env.TMUX_TMPDIR = tmuxTmpdir
  const id = Math.random().toString(36).slice(2, 8)
  session = `kobe-sp6-${id}`
  socketPath = fallbackTestSocketPath(`kobe-sp6-${id}`)
  pidPath = path.join(tmpRoot, "daemon.pid")
  const result = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`repo-init.sh failed: ${result.stderr}\n${result.stdout}`)
})

afterEach(async () => {
  if (server) {
    try {
      await server.close()
    } catch {
      /* ignore */
    }
    server = null
  }
  if (orch) {
    orch.dispose()
    orch = null
  }
  if (session) {
    // Kill the dedicated tmux server (we used a unique TMUX_TMPDIR).
    // That tears down the session and all its panes in one call.
    spawnSync("tmux", ["kill-server"], { stdio: "ignore" })
  }
  if (originalPath) process.env.PATH = originalPath
  // `process.env.X = undefined` would set X to the string "undefined";
  // an actual `delete` undoes the per-test setenv cleanly.
  // biome-ignore lint/performance/noDelete: env restoration requires real delete (see above)
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  // biome-ignore lint/performance/noDelete: env restoration requires real delete (see above)
  if (originalTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR
  else process.env.TMUX_TMPDIR = originalTmuxTmpdir
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function tmuxCli(...args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("tmux", args, { encoding: "utf8" })
  return { status: r.status ?? -1, stdout: (r.stdout ?? "").toString(), stderr: (r.stderr ?? "").toString() }
}

function tmuxCapture(args: string[]): string {
  const r = tmuxCli(...args)
  if (r.status !== 0) {
    throw new Error(`tmux ${args.join(" ")} failed (${r.status}): ${r.stderr.trim()}`)
  }
  return r.stdout.trim()
}

function runLayoutStepViaCli(step: LayoutStep, paneIds: Map<PaneLabel, string>): void {
  if (step.kind === "new-session") {
    const id = tmuxCapture([
      "new-session",
      "-d",
      "-s",
      step.sessionName,
      "-n",
      step.windowName,
      "-P",
      "-F",
      "#{pane_id}",
      step.command,
    ])
    paneIds.set(step.name, id)
    return
  }
  if (step.kind === "split") {
    const target = paneIds.get(step.targetLabel)
    if (!target) throw new Error(`unknown target ${step.targetLabel}`)
    const id = tmuxCapture([
      "split-window",
      `-${step.direction}`,
      "-t",
      target,
      "-l",
      step.size,
      "-P",
      "-F",
      "#{pane_id}",
      step.command,
    ])
    paneIds.set(step.name, id)
    return
  }
  if (step.kind === "resize") {
    const target = paneIds.get(step.targetLabel)
    if (!target) throw new Error(`unknown target ${step.targetLabel}`)
    tmuxCapture(["resize-pane", "-t", target, "-y", String(step.heightRows)])
    return
  }
  if (step.kind === "select") {
    const target = paneIds.get(step.targetLabel)
    if (!target) throw new Error(`unknown target ${step.targetLabel}`)
    tmuxCapture(["select-pane", "-t", target])
    return
  }
}

async function waitFor<T>(probe: () => T | null | undefined, timeoutMs = 5000, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = probe()
    if (v !== null && v !== undefined) return v
    await new Promise<void>((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

it.skipIf(!tmuxAvailable)(
  "sprint-6: bootstrap → tmux.attach → rpc.newTab spawns + swaps + sniffs sessionId end-to-end",
  async () => {
    // 1. Build the actual 5-pane main window via the same step machine
    //    bootstrap.ts uses, then capture the chat slot's pane id +
    //    saved layout — the two values bootstrap sends along with
    //    `tmux.attach`.
    const steps = buildLayoutSteps({ sessionName: session, placeholders: DEFAULT_PLACEHOLDERS })
    const paneIds = new Map<PaneLabel, string>()
    for (const step of steps) runLayoutStepViaCli(step, paneIds)
    const chatSlotId = paneIds.get("chat")
    if (!chatSlotId) throw new Error("expected chat pane id")
    expect(chatSlotId).toMatch(/^%\d+$/)
    const savedLayout = tmuxCapture(["display-message", "-p", "-t", `${session}:kobe`, "#{window_visible_layout}"])
    expect(savedLayout.length).toBeGreaterThan(0)

    // 2. Bring up the hidden stash window with a seed placeholder pane.
    tmuxCapture(["new-window", "-d", "-t", session, "-n", "stash", placeholderShellCommand("stash-init")])
    const stashWindow = `${session}:stash`

    // 3. Start the daemon in-process (rpc-handlers test pattern). Real
    //    Orchestrator + FakeAIEngine — task.spawn → runTask allocates
    //    the worktree without actually invoking claude.
    const store = new TaskIndexStore({ homeDir })
    await store.load()
    const localOrch = new Orchestrator({
      engine: new FakeAIEngine(),
      store,
      worktrees: new GitWorktreeManager(),
      metadataSuggester: new NoopMetadataSuggester(),
    })
    orch = localOrch
    server = await startDaemonServer(localOrch, { socketPath, pidPath, homeDir })

    const client = new KobeDaemonClient(socketPath)
    try {
      await client.connect()

      // 4. tmux.attach binds the daemon to the live session.
      await client.request("tmux.attach", {
        session,
        stashWindow,
        chatSlotPaneId: chatSlotId,
        savedLayout,
      })

      // 5. Spawn a task. Provide a prompt so the orchestrator allocates
      //    the worktree (otherwise `task.worktreePath` is empty and the
      //    daemon-side sniff has no cwd to look at).
      const spawned = await client.request<{ taskId: string; task: { worktreePath: string } }>("task.spawn", {
        repo,
        title: "sprint-6",
        prompt: "hi",
      })
      // FakeAIEngine returns done immediately for unscripted sessions,
      // but runTask still has to allocate the worktree + tab session
      // id. Poll task.get until worktreePath is non-empty.
      const wt = await waitFor(() => {
        const t = localOrch.getTask(spawned.taskId)
        return t?.worktreePath ? t.worktreePath : null
      })
      expect(wt.length).toBeGreaterThan(0)

      // 6. Foreground the task. The first tab has no pane registered
      //    yet (only rpc.newTab calls ensure+swap+sniff), so this swap
      //    will fail silently inside the adapter and be logged — the
      //    rpc still succeeds. The point is to set activeTaskId so the
      //    next rpc.newTab knows what task to spawn the new tab on.
      await client.request("rpc.switchTask", { id: spawned.taskId })

      // Snapshot main + stash membership BEFORE rpc.newTab so we can
      // detect the swap-into-chat by membership delta rather than count
      // (the swap exchanges two panes, so neither window's pane count
      // changes — only the membership does).
      const mainBefore = new Set(
        tmuxCapture(["list-panes", "-t", `${session}:kobe`, "-F", "#{pane_id}"])
          .split("\n")
          .filter(Boolean),
      )
      const stashBefore = new Set(
        tmuxCapture(["list-panes", "-t", stashWindow, "-F", "#{pane_id}"]).split("\n").filter(Boolean),
      )
      expect(mainBefore.size).toBe(5)
      expect(stashBefore.size).toBe(1)
      expect(mainBefore.has(chatSlotId)).toBe(true)

      // 7. New tab → daemon spawns a fresh claude pane in the stash
      //    window, swaps it into the chat slot, and sniffs the
      //    sessionId once the fake claude has written its JSONL.
      const newTab = await client.request<{ tabId: string }>("rpc.newTab")
      expect(newTab.tabId).toMatch(/^[0-9A-Z]+$/)

      // 8. After the swap, the original chat slot pane id moves OUT of
      //    the main window and INTO the stash window. The new tab's
      //    pane id (whatever id tmux assigned to it during split-window)
      //    takes its place in the main window. Poll because the swap
      //    is async fire-and-forget on the daemon side.
      await waitFor(() => {
        const stash = tmuxCapture(["list-panes", "-t", stashWindow, "-F", "#{pane_id}"]).split("\n").filter(Boolean)
        return stash.includes(chatSlotId) ? true : null
      })
      const mainAfter = tmuxCapture(["list-panes", "-t", `${session}:kobe`, "-F", "#{pane_id}"])
        .split("\n")
        .filter(Boolean)
      expect(mainAfter).not.toContain(chatSlotId)
      // The main window picked up a new pane id — the per-tab pane just
      // swapped in.
      const swappedIn = mainAfter.filter((id) => !mainBefore.has(id))
      expect(swappedIn).toHaveLength(1)
      const swappedInId = swappedIn[0]
      if (!swappedInId) throw new Error("expected exactly one swapped-in pane id")

      // 9. Wait for the sniffed sessionId to be persisted on the new
      //    tab. The fake `claude` writes a UUID JSONL the moment it
      //    starts; the daemon polls 500ms intervals for up to 5s.
      const sniffedSid = await waitFor(() => {
        const t = localOrch.getTask(spawned.taskId)
        const tab = t?.tabs.find((x) => x.id === newTab.tabId)
        return tab?.sessionId ?? null
      }, 10_000)
      expect(sniffedSid).toMatch(/^[0-9a-zA-Z-]+$/)

      // 10. The persisted sessionId matches a file on disk under the
      //     fake home's claude projects dir.
      const encoded = wt.replace(/[/.]/g, "-")
      const files = fs.readdirSync(path.join(homeDir, ".claude", "projects", encoded))
      expect(files).toContain(`${sniffedSid}.jsonl`)

      // (NOTE: rpc.closeTab on the active tab is intentionally not
      // exercised here — only `rpc.newTab` calls the ensure-then-swap
      // path in sprint-6, so the rpc.closeTab `safeSwap → safeKill`
      // sequence has no pane registered for the surviving tab and
      // refuses to kill a pane that's still in the chat slot. That's
      // expected sprint-6 behavior; sprint-7 will lift it by routing
      // every active-state mutation through ensure-and-swap.)
      // Sanity: the closing dance is a no-op (the swap fails because
      // tab1 has no pane and the kill fails because tab2 is still
      // displayed), but the rpc itself succeeds.
      const closeResult = await client.request<{ ok: boolean; nextActive: string }>("rpc.closeTab")
      expect(closeResult.ok).toBe(true)
      expect(closeResult.nextActive).toBeTruthy()
      // Use swappedInId so TS doesn't complain about an unused binding —
      // future sprint-7 assertion will cover the kill.
      expect(swappedInId).toMatch(/^%\d+$/)
    } finally {
      client.close()
    }
  },
  60_000,
)
