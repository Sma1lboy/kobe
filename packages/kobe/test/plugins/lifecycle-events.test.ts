import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lifecycleEventFor } from "@sma1lboy/kobe-daemon/plugins/events"
import { savePluginRegistry } from "@sma1lboy/kobe-daemon/plugins/registry"
import { PluginHost } from "@sma1lboy/kobe-daemon/plugins/runtime"
import { afterEach, describe, expect, it } from "vitest"
import {
  ACTIVITY_STATE_KINDS,
  ENGINE_ACTIVITY_KINDS,
  affectsActivityState,
  reduceActivity,
} from "../../src/engine/hook-events"

const dirs: string[] = []
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function waitFor(predicate: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe("lifecycleEventFor", () => {
  it("maps every lifecycle verb; splits awaiting-input by why", () => {
    expect(lifecycleEventFor("session-start")).toBe("session.start")
    expect(lifecycleEventFor("turn-start")).toBe("turn.prompt")
    expect(lifecycleEventFor("turn-interrupted")).toBe("turn.interrupted")
    expect(lifecycleEventFor("tool-post")).toBe("tool.post")
    expect(lifecycleEventFor("pre-compact")).toBe("context.pre-compact")
    expect(lifecycleEventFor("subagent-stop")).toBe("subagent.stop")
    expect(lifecycleEventFor("awaiting-input", { waiting: "permission" })).toBe("attention.permission")
    expect(lifecycleEventFor("awaiting-input", { waiting: "input" })).toBe("attention.question")
    expect(lifecycleEventFor("no-such-kind")).toBeUndefined()
  })

  it("covers every engine verb (no lifecycle event silently dropped)", () => {
    for (const kind of ENGINE_ACTIVITY_KINDS) {
      expect(lifecycleEventFor(kind), kind).toBeDefined()
    }
  })
})

describe("activity-state gating", () => {
  it("state kinds affect the badge; lifecycle-only kinds do not", () => {
    for (const kind of ACTIVITY_STATE_KINDS) expect(affectsActivityState(kind), kind).toBe(true)
    for (const kind of ["tool-pre", "tool-post", "tool-failed", "pre-compact", "subagent-start"]) {
      expect(affectsActivityState(kind), kind).toBe(false)
    }
  })

  it("turn-interrupted lands the state back on idle", () => {
    expect(reduceActivity("running", "turn-interrupted")).toBe("idle")
  })
})

const MANIFEST = `
id = "example.lifecycle"
name = "Lifecycle"
version = "0.1.0"
min_kobe_version = "0.1.0"

[[events]]
on = "tool.post"
command = ["sh", "-c", "printf %s \\"$KOBE_PLUGIN_EVENT\\" > tool.txt && printf %s \\"$KOBE_PLUGIN_EVENT_JSON\\" > payload.json"]
`

describe("PluginHost.handleEngineReport", () => {
  it("fires declared lifecycle hooks with the envelope", async () => {
    const home = tmp("kobe-lifecycle-home-")
    const root = tmp("kobe-lifecycle-root-")
    writeFileSync(join(root, "kobe-plugin.toml"), MANIFEST)
    mkdirSync(join(home, ".kobe"), { recursive: true })
    savePluginRegistry(
      {
        plugins: [
          { id: "example.lifecycle", source: { kind: "link" }, root, enabled: true, version: "0.1.0", installedAt: 1 },
        ],
      },
      home,
    )
    const host = new PluginHost({ homeDir: home, socketPath: "/tmp/fake.sock", binPath: "kobe" })
    host.start()
    try {
      // An undeclared event dispatches nothing.
      host.handleEngineReport({ kind: "pre-compact", taskId: "t1" })
      // The declared one fires with the normalized envelope.
      host.handleEngineReport({
        kind: "tool-post",
        taskId: "t1",
        vendor: "claude",
        detail: { tool: { name: "Bash" } },
      })
      await waitFor(() => existsSync(join(root, "tool.txt")))
      expect(readFileSync(join(root, "tool.txt"), "utf8")).toBe("tool.post")
      const payload = JSON.parse(readFileSync(join(root, "payload.json"), "utf8"))
      expect(payload).toMatchObject({
        event: "tool.post",
        taskId: "t1",
        vendor: "claude",
        detail: { tool: { name: "Bash" } },
      })
    } finally {
      host.stop()
    }
  })
})
