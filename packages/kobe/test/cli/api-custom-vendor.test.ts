/**
 * `--vendor` accepts registered CUSTOM engines, not just the built-ins.
 *
 * Engines are an open set: a user registers a slug in `customEngineIds` and
 * its launch command in `engineCommand.<id>`, the TUI's selector offers it,
 * and the daemon accepts any non-empty string for exactly this reason
 * (`optionalVendor`). But the CLI's flag layer validated against the closed
 * built-in list, so every custom engine was unsettable from `kobe api` —
 * `set-vendor` rejected it before a handler ever saw it.
 *
 * Two gates had to agree, and both are pinned here: the spec pre-validator
 * (`validateAgainstSpec`, which runs before any handler) and the accessor
 * (`VerbArgs.vendor`).
 *
 * The third gate is DISCOVERY: accepting a custom id at runtime is worthless
 * when `schema` / `--help` still list only the built-ins — an agent reading
 * the surface never learns the engine exists. The render layer
 * (`displayValues` in schema.ts) appends the registered ids at render time;
 * that visibility is pinned here too.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { invokeVerb } from "../../src/cli/api-cmd.ts"
import { verbHelp, verbSchema } from "../../src/cli/api/schema.ts"
import { findVerb } from "../../src/cli/api/verbs.ts"
import { ALL_VENDORS } from "../../src/types/vendor.ts"
import { FakeClient, expectApiError, stubRuntime, taskFixture } from "./api-handler-fixtures.ts"

let home: string
let originalHome: string | undefined

function writeState(state: Record<string, unknown>): void {
  const dir = join(home, ".config", "kobe")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "state.json"), JSON.stringify(state), "utf8")
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kobe-custom-vendor-"))
  originalHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = home
})

afterEach(() => {
  if (originalHome === undefined) {
    // biome-ignore lint/performance/noDelete: the var must be truly unset when it started unset.
    delete process.env.KOBE_HOME_DIR
  } else process.env.KOBE_HOME_DIR = originalHome
  rmSync(home, { recursive: true, force: true })
})

const runtime = stubRuntime()

describe("set-vendor with a custom engine", () => {
  it("accepts a registered custom engine id", async () => {
    writeState({ customEngineIds: ["claudecpa"], "engineCommand.claudecpa": "claudecpa" })
    const client = new FakeClient({ "task.setVendor": () => ({}) })
    await invokeVerb("set-vendor", ["--task-id", "t1", "--vendor", "claudecpa"], { client, runtime })
    expect(client.requests).toEqual([{ name: "task.setVendor", payload: { taskId: "t1", vendor: "claudecpa" } }])
  })

  it("still accepts the built-ins", async () => {
    writeState({ customEngineIds: ["claudecpa"] })
    const client = new FakeClient({ "task.setVendor": () => ({}) })
    await invokeVerb("set-vendor", ["--task-id", "t1", "--vendor", "codex"], { client, runtime })
    expect((client.requests[0]?.payload as { vendor: string }).vendor).toBe("codex")
  })

  it("rejects an id that is neither built-in nor registered", async () => {
    writeState({ customEngineIds: ["claudecpa"] })
    const client = new FakeClient({ "task.setVendor": () => ({}) })
    await expectApiError(
      () => invokeVerb("set-vendor", ["--task-id", "t1", "--vendor", "frobnicate"], { client, runtime }),
      "BAD_FLAG",
    )
  })

  it("rejects every custom id when the registry is empty", async () => {
    writeState({})
    const client = new FakeClient({ "task.setVendor": () => ({}) })
    await expectApiError(
      () => invokeVerb("set-vendor", ["--task-id", "t1", "--vendor", "claudecpa"], { client, runtime }),
      "BAD_FLAG",
    )
  })
})

describe("other verbs reading --vendor", () => {
  it("`add` carries a custom engine through to task.create", async () => {
    writeState({ customEngineIds: ["pi"], "engineCommand.pi": "pi" })
    const client = new FakeClient({ "task.create": () => ({ taskId: "t9", task: taskFixture({ id: "t9" }) }) })
    await invokeVerb("add", ["--repo", "/repo/x", "--vendor", "pi"], { client, runtime })
    expect((client.requests[0]?.payload as { vendor: string }).vendor).toBe("pi")
  })
})

describe("schema / --help discovery", () => {
  function vendorValues(detail: unknown): string[] {
    const flags = (detail as { flags: { name: string; values?: string[] }[] }).flags
    return flags.find((f) => f.name === "vendor")?.values ?? []
  }

  it("verbSchema lists registered custom engines in --vendor values", () => {
    writeState({ customEngineIds: ["claudecpa"] })
    const detail = verbSchema(findVerb("set-vendor")!)
    expect(vendorValues(detail)).toContain("claudecpa")
    expect(vendorValues(detail)).toContain("claude")
  })

  it("--help text shows the custom engine in the enum brace list", () => {
    writeState({ customEngineIds: ["claudecpa"] })
    expect(verbHelp(findVerb("add")!)).toMatch(/--vendor \{[^}]*\bclaudecpa\b[^}]*\}/)
  })

  it("lists only built-ins when no custom engine is registered", () => {
    writeState({})
    const detail = verbSchema(findVerb("set-vendor")!)
    expect(vendorValues(detail)).toEqual([...ALL_VENDORS])
  })
})
