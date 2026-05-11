/**
 * Real-binary tests for `CodexLocal`.
 *
 * These tests **invoke the actual `codex` CLI** against the user's
 * real auth / model config. They prove the adapter end-to-end —
 * spawn / resume / stop / readHistory / listSessions / deleteHistory /
 * orchestrator routing — against the live tool, not a fake.
 *
 * Auto-skipped when:
 *   - `codex` is not on PATH (CI, devs who don't use codex).
 *   - `KOBE_SKIP_CODEX_REAL=1` is set (explicit opt-out for local CI
 *     runs that don't want to pay tokens).
 *
 * Cost: each test runs a real codex turn (~5-15s, modest token usage).
 * V5 deletes the rollout it created in V1 so the user's history isn't
 * polluted by repeated runs.
 *
 * Why this isn't a unit test:
 *   - The whole point is to catch regressions when codex CLI updates
 *     change flags, JSONL shape, or rollout-file layout. A mock won't
 *     catch that — only the real binary will.
 *   - This is the test that found `codex exec resume` rejects -C/-s,
 *     which the V1 smoke test (no resume) missed entirely.
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createKobeCore } from "@/core/index"
import { CodexLocal } from "@/engine/codex-local/index"
import { findRolloutFile } from "@/engine/codex-local/history"

const codexAvailable =
  process.env.KOBE_SKIP_CODEX_REAL !== "1" && spawnSync("which", ["codex"], { encoding: "utf8" }).status === 0

const d = codexAvailable ? describe : describe.skip

// Single engine instance shared across V1-V5 so V2 can resume V1's
// session and V5 can clean up V1's rollout. V3, V6, V7 use their own.
const engine = new CodexLocal()
let v1SessionId: string | undefined

const PERMISSION = { permissionMode: "default" as const }

d("CodexLocal — real binary smoke (V1-V6)", () => {
  test("V1: spawn → assistant.delta + usage + done", { timeout: 60_000 }, async () => {
    const handle = await engine.spawn("/tmp", "Reply with exactly the word PONG and nothing else.", PERMISSION)
    expect(handle.sessionId).toMatch(/^[0-9a-f-]{36}$/i)
    v1SessionId = handle.sessionId
    const events: any[] = []
    for await (const ev of engine.stream(handle)) {
      events.push(ev)
      if (ev.type === "done" || ev.type === "error") break
    }
    const types = events.map((e) => e.type)
    expect(types).toContain("assistant.delta")
    expect(types).toContain("usage")
    expect(types[types.length - 1]).toBe("done")
    const reply = events.find((e) => e.type === "assistant.delta")?.text ?? ""
    expect(reply).toMatch(/pong/i)
  })

  test("V2: resume on existing session — context carries over", { timeout: 60_000 }, async () => {
    expect(v1SessionId).toBeDefined()
    const handle = await engine.resume(v1SessionId as string, "What word did I ask you to say? Reply with just that word.", {
      cwd: "/tmp",
      ...PERMISSION,
    })
    expect(handle.sessionId).toBe(v1SessionId)
    const events: any[] = []
    for await (const ev of engine.stream(handle)) {
      events.push(ev)
      if (ev.type === "done" || ev.type === "error") break
    }
    expect(events.find((e) => e.type === "done")).toBeDefined()
    const reply = events.find((e) => e.type === "assistant.delta")?.text ?? ""
    expect(reply).toMatch(/pong/i)
  })

  test("V3: stop(handle) terminates a live turn", { timeout: 30_000 }, async () => {
    const stopEngine = new CodexLocal()
    const handle = await stopEngine.spawn(
      "/tmp",
      "Count slowly from 1 to 30 with a comma between each number. Do not stop until you reach 30.",
      PERMISSION,
    )
    const drained: unknown[] = []
    const drainPromise = (async () => {
      for await (const ev of stopEngine.stream(handle)) {
        drained.push(ev)
        if (drained.length === 1) await stopEngine.stop(handle)
      }
    })()
    await Promise.race([
      drainPromise,
      sleep(20_000).then(() => Promise.reject(new Error("stop() didn't terminate the stream within 20s"))),
    ])
    // Idempotent
    await stopEngine.stop(handle)
    expect(drained.length).toBeGreaterThan(0)
  })

  test("V4: readHistory + listSessionsForCwd on V1's session", { timeout: 15_000 }, async () => {
    expect(v1SessionId).toBeDefined()
    // Codex writes rollouts async; give it a beat.
    await sleep(500)
    const history = await engine.readHistory(v1SessionId as string)
    expect(history.length).toBeGreaterThanOrEqual(2)
    const roles = new Set(history.map((m) => m.role))
    expect(roles.has("user")).toBe(true)
    expect(roles.has("assistant")).toBe(true)
    const sessions = await engine.listSessions("/tmp")
    const found = sessions.find((s) => s.sessionId === v1SessionId)
    expect(found, "V1 session should appear in listSessions(/tmp)").toBeDefined()
  })

  test("V5: deleteHistory unlinks the rollout; second read returns []", { timeout: 15_000 }, async () => {
    expect(v1SessionId).toBeDefined()
    const before = await findRolloutFile(v1SessionId as string)
    expect(before).toBeDefined()
    expect(existsSync(before as string)).toBe(true)
    await engine.deleteHistory(v1SessionId as string)
    const after = await findRolloutFile(v1SessionId as string)
    expect(after).toBeUndefined()
    expect(await engine.readHistory(v1SessionId as string)).toEqual([])
    // Idempotent
    await engine.deleteHistory(v1SessionId as string)
  })

  test("V6: bad binary path rejects spawn cleanly", { timeout: 10_000 }, async () => {
    const bad = new CodexLocal({ binaryPathResolver: async () => "/definitely/not/a/binary" })
    await expect(bad.spawn("/tmp", "noop", PERMISSION)).rejects.toBeDefined()
  })

  // V8 pins each CODEX_MODELS catalog entry explicitly and asserts
  // codex doesn't reject it with the ChatGPT-account 400 error. This
  // is the regression that would have caught the initial bad catalog
  // (`gpt-5-codex` / `gpt-5` / `o3`) — V1-V6 all used the codex config
  // default, so the catalog could silently drift away from
  // ChatGPT-account-compatible ids and tests would still pass.
  test("V8: every CODEX_MODELS entry actually accepted by codex", { timeout: 120_000 }, async () => {
    const { CODEX_MODELS } = await import("@/engine/codex-local/models")
    const failures: { id: string; error: string }[] = []
    for (const choice of CODEX_MODELS) {
      const handle = await engine.spawn("/tmp", "Reply with exactly the word OK.", {
        ...PERMISSION,
        model: choice.id,
      })
      const events: any[] = []
      for await (const ev of engine.stream(handle)) {
        events.push(ev)
        if (ev.type === "done" || ev.type === "error") break
      }
      const err = events.find((e) => e.type === "error")
      if (err) {
        const msg = String(err.message).toLowerCase()
        // 400 invalid_request_error includes "model is not supported"
        // or "not supported when using codex with a chatgpt account".
        // Either is a catalog regression.
        if (msg.includes("not supported") || msg.includes("invalid_request_error")) {
          failures.push({ id: choice.id, error: err.message.slice(0, 200) })
        }
        // Other errors (rate limit, transient network) are tolerated
        // — V8 only enforces the model-id contract.
      }
      // Best-effort cleanup so we don't pile up rollouts during this test.
      try { await engine.deleteHistory(handle.sessionId) } catch { /* noop */ }
    }
    expect(failures, `unsupported models in catalog: ${JSON.stringify(failures)}`).toEqual([])
  })
})

d("CodexLocal — orchestrator end-to-end (V7)", () => {
  // V7 boots a full `createKobeCore` with a one-vendor engine map and
  // proves `runTask` routes through CodexLocal when Task.vendor is codex.
  // Uses model=null so the test doesn't depend on the user's account
  // accepting any specific id; codex picks the default from
  // ~/.codex/config.toml (works on a fresh `codex login`).
  let tmpHome: string
  let repo: string

  beforeAll(() => {
    tmpHome = mkdtempSync(path.join(tmpdir(), "kobe-codex-e2e-"))
    repo = mkdtempSync(path.join(tmpdir(), "kobe-codex-repo-"))
    spawnSync("git", ["init", "-q", "-b", "main", repo])
    writeFileSync(path.join(repo, "README.md"), "hello\n")
    spawnSync("git", ["-C", repo, "add", "-A"])
    spawnSync("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "init",
    ])
  })

  afterAll(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* noop */ }
    try { rmSync(repo, { recursive: true, force: true }) } catch { /* noop */ }
  })

  test("Task with vendor=codex routes to CodexLocal; full event stream reaches subscribers", { timeout: 120_000 }, async () => {
    let codexSpawned = false
    const codex = new CodexLocal()
    const origSpawn = codex.spawn.bind(codex)
    codex.spawn = async (cwd, prompt, opts) => {
      codexSpawned = true
      return origSpawn(cwd, prompt, opts)
    }

    const core = await createKobeCore({
      homeDir: tmpHome,
      engines: { codex },
      startMcpBridge: false,
    })
    try {
      const orch = core.orchestrator
      const task = await orch.createTask({ repo, title: "codex e2e", prompt: "" })
      // Don't pin a model — let codex use its config-resolved default
      // (whatever the running user's `~/.codex/config.toml` says).
      // Force vendor directly via the store so routing kicks in.
      await (orch as unknown as { store: { update: (id: string, patch: unknown) => Promise<void> } }).store.update(
        task.id,
        { vendor: "codex" },
      )
      const after = orch.getTask(task.id)
      expect(after?.vendor).toBe("codex")
      const tab = after?.tabs[0]
      expect(tab).toBeDefined()

      const events: any[] = []
      const unsub = orch.subscribeEvents(
        task.id,
        (ev) => {
          events.push(ev)
        },
        tab!.id,
      )
      try {
        await orch.runTask(task.id, "Reply with exactly the word PONG and nothing else.")
        const deadline = Date.now() + 90_000
        while (Date.now() < deadline) {
          if (events.some((e) => e.type === "done" || e.type === "error")) break
          await sleep(200)
        }
      } finally {
        unsub()
      }

      expect(codexSpawned, "CodexLocal.spawn should have been invoked by runTask routing").toBe(true)
      const terminal = events.find((e) => e.type === "done" || e.type === "error")
      expect(terminal, "should reach a terminal event").toBeDefined()
      // The user's codex auth may reject specific model ids; we accept
      // a terminal "error" here as long as the routing reached codex.
      // Happy-path users see a done + a PONG reply.
      if (terminal?.type === "done") {
        const reply = events.find((e) => e.type === "assistant.delta")?.text ?? ""
        expect(reply).toMatch(/pong/i)
      }
    } finally {
      await core.close()
    }
  })
})
