/**
 * Regression: runTask must emit a user.inject event for the user's
 * prompt BEFORE spawning the engine. Otherwise multi-attach clients
 * never see the user's message — and after the Chat composer stopped
 * pushing the user row locally, even the typing window stops seeing
 * its own messages.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { Orchestrator } from "../../src/orchestrator/core.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import { MetadataSuggester } from "../../src/orchestrator/metadata-suggester.ts"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"
import type { OrchestratorEvent } from "../../src/types/engine.ts"
import { FakeAIEngine } from "../behavior/fake-engine.ts"

const REPO_INIT = path.resolve(__dirname, "../behavior/fixtures/repo-init.sh")

let tmpRoot: string
let homeDir: string
let repo: string

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

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-run-user-inject-"))
  homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })
  repo = path.join(tmpRoot, "repo")
  const r = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`repo-init.sh failed: ${r.stderr}\n${r.stdout}`)
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

test("runTask emits user.inject for the user's prompt before any assistant events", async () => {
  const engine = new FakeAIEngine()
  const store = new TaskIndexStore({ homeDir })
  await store.load()
  const orch = new Orchestrator({
    engine,
    store,
    worktrees: new GitWorktreeManager(),
    metadataSuggester: new NoopMetadataSuggester(),
  })
  const task = await orch.createTask({ repo, title: "user-inject" })

  const events: OrchestratorEvent[] = []
  orch.subscribeEvents(task.id, (ev) => events.push(ev), task.activeTabId)

  engine.script("fake-1", [{ type: "assistant.delta", text: "hi back" }, { type: "done" }])
  await orch.runTask(task.id, "hi from user", task.activeTabId)
  await (orch as unknown as { _waitForPumpsIdle: () => Promise<void> })._waitForPumpsIdle()

  const userInject = events.find((e) => e.type === "user.inject")
  expect(userInject).toBeDefined()
  // The user.inject must precede the assistant.delta — otherwise the
  // chat reducer concatenates the assistant text into the previous
  // assistant row instead of starting a new turn.
  const userIdx = events.findIndex((e) => e.type === "user.inject")
  const deltaIdx = events.findIndex((e) => e.type === "assistant.delta")
  expect(userIdx).toBeGreaterThanOrEqual(0)
  expect(deltaIdx).toBeGreaterThan(userIdx)
})

test("runTask with blank/undefined prompt does NOT emit user.inject (continue/resume path)", async () => {
  const engine = new FakeAIEngine()
  const store = new TaskIndexStore({ homeDir })
  await store.load()
  const orch = new Orchestrator({
    engine,
    store,
    worktrees: new GitWorktreeManager(),
    metadataSuggester: new NoopMetadataSuggester(),
  })
  const task = await orch.createTask({ repo, title: "resume" })

  const events: OrchestratorEvent[] = []
  orch.subscribeEvents(task.id, (ev) => events.push(ev), task.activeTabId)

  engine.script("fake-1", [{ type: "done" }])
  await orch.runTask(task.id, undefined, task.activeTabId)
  await (orch as unknown as { _waitForPumpsIdle: () => Promise<void> })._waitForPumpsIdle()

  expect(events.find((e) => e.type === "user.inject")).toBeUndefined()
})
