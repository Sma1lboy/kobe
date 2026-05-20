/**
 * Sprint-8 (KOB-213 closeout) end-to-end behavior test.
 *
 * Two smoke assertions:
 *
 *   1. Build the same 5-pane main window the production bootstrap
 *      builds (via `buildLayoutSteps`) and assert all 5 panes are
 *      alive — proves the layout grammar still compiles into a real
 *      tmux window post-sprint-8.
 *   2. Spawn `kobe pane sidebar --once` as a real subprocess pointed
 *      at an in-process daemon socket. Assert exit 0 + stdout
 *      contains the plain-text sidebar marker within 2s. Solid frame
 *      snapshots are intentionally NOT asserted (notoriously flaky);
 *      `--once` stays on the plain-text path precisely so this smoke
 *      test doesn't have to spin up the opentui renderer.
 *
 * Gated on tmux availability + a discoverable `bun` binary (the
 * subprocess re-invokes kobe via `bun packages/kobe/src/cli/index.ts`).
 */

import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
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
} from "../../src/tmux/layout.ts"
import { FakeAIEngine } from "./fake-engine.ts"

const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0
const bunBin = process.env.BUN_BIN ?? "bun"
const CLI_PATH = path.resolve(__dirname, "../../src/cli/index.ts")

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
let session = ""
let socketPath = ""
let pidPath = ""
let server: DaemonServer | null = null
let orch: Orchestrator | null = null
let originalTmuxTmpdir: string | undefined

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-sprint8-"))
  homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })
  originalTmuxTmpdir = process.env.TMUX_TMPDIR
  const tmuxTmpdir = path.join(tmpRoot, "tmux")
  fs.mkdirSync(tmuxTmpdir, { recursive: true })
  process.env.TMUX_TMPDIR = tmuxTmpdir
  const id = Math.random().toString(36).slice(2, 8)
  session = `kobe-sp8-${id}`
  socketPath = fallbackTestSocketPath(`kobe-sp8-${id}`)
  pidPath = path.join(tmpRoot, "daemon.pid")
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
    spawnSync("tmux", ["kill-server"], { stdio: "ignore" })
  }
  // biome-ignore lint/performance/noDelete: env restoration requires real delete
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
  if (r.status !== 0) throw new Error(`tmux ${args.join(" ")} failed (${r.status}): ${r.stderr.trim()}`)
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

interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
}

function runSubprocess(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(bunBin, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        /* ignore */
      }
      reject(new Error(`subprocess timed out after ${timeoutMs}ms: ${args.join(" ")}\nstdout: ${stdout}\nstderr: ${stderr}`))
    }, timeoutMs)
    child.stdout.on("data", (b) => {
      stdout += b.toString()
    })
    child.stderr.on("data", (b) => {
      stderr += b.toString()
    })
    child.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? -1, stdout, stderr })
    })
  })
}

it.skipIf(!tmuxAvailable)("sprint-8: 5-pane main window builds and all panes are alive", () => {
  const steps = buildLayoutSteps({ sessionName: session, placeholders: DEFAULT_PLACEHOLDERS })
  const paneIds = new Map<PaneLabel, string>()
  for (const step of steps) runLayoutStepViaCli(step, paneIds)

  const mainPanes = tmuxCapture(["list-panes", "-t", `${session}:kobe`, "-F", "#{pane_id}"])
    .split("\n")
    .filter(Boolean)
  expect(mainPanes.length).toBe(5)
  // Every pane id captured during the build must be present in the live window.
  for (const label of ["sidebar", "tab-strip", "chat", "files", "shell"] as const) {
    const id = paneIds.get(label)
    expect(id, `expected pane id for ${label}`).toBeDefined()
    if (id) expect(mainPanes).toContain(id)
  }
})

it("sprint-8: `kobe pane sidebar --once` connects to daemon and prints sidebar marker", async () => {
  // In-process daemon + Orchestrator + FakeAIEngine. No tasks, so the
  // subprocess should print the empty-sidebar marker.
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

  const result = await runSubprocess(
    [CLI_PATH, "pane", "sidebar", "--once"],
    {
      ...process.env,
      KOBE_DAEMON_SOCKET_PATH: socketPath,
      KOBE_HOME_DIR: homeDir,
      // Force the bootstrap path off (it would otherwise check $TMUX,
      // but this subprocess is just running `kobe pane …` which never
      // reaches the bootstrap call).
      KOBE_TMUX: "0",
    },
    5000,
  )
  expect(result.exitCode, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0)
  expect(result.stdout).toContain("[sidebar]")
})
