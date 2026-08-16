/**
 * Custom engines are NAMED PRESETS on the dispatch face.
 *
 * A user registers a slug in `customEngineIds`, its launch command in
 * `engineCommand.<id>`, and — the piece this suite exists for — the protocol
 * it speaks in `engineProtocol.<id>`. That declaration is what makes
 * `--command my-engine` deterministic: the protocol is resolved from the
 * command's argv[0] before anything spawns, not sniffed afterwards.
 *
 * Three things are pinned here:
 *   - `engine-list` is WYSIWYG: every entry's raw command, so an agent can
 *     copy one into `--command` and edit its flags.
 *   - protocol resolution tiers: preset id → registered command's argv[0] →
 *     built-in binary (including through wrappers) → `generic`.
 *   - `--vendor` survives on the surfaces the dispatch face does NOT own
 *     (routines, work-items), where an engine is still picked by id.
 *
 * `--vendor` on `add`/`send`/`set-vendor` is gone (issue #30); the closed-
 * enum-vs-open-registry gate those verbs used to need went with it, because
 * `--command` is a plain string with no enum to disagree about.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { invokeVerb } from "../../src/cli/api-cmd.ts"
import { verbHelp, verbSchema } from "../../src/cli/api/schema.ts"
import { findVerb } from "../../src/cli/api/verbs.ts"
import { GENERIC_PROTOCOL, listEnginePresets, resolveCommandProtocol } from "../../src/engine/engine-presets.ts"
import { ALL_VENDORS } from "../../src/types/vendor.ts"
import { FakeClient, stubRuntime, taskFixture } from "./api-handler-fixtures.ts"

let home: string
let originalHome: string | undefined

function writeState(state: Record<string, unknown>): void {
  const dir = join(home, ".config", "rove")
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

describe("engine-list", () => {
  it("shows every built-in with the command it actually launches", async () => {
    writeState({})
    const { engines } = (await invokeVerb("engine-list", [], { client: null, runtime })) as {
      engines: Array<{ id: string; command: string; protocol: string; builtin: boolean }>
    }
    expect(engines.map((e) => e.id)).toEqual([...ALL_VENDORS])
    const claude = engines.find((e) => e.id === "claude")
    expect(claude).toMatchObject({ command: "claude", protocol: "claude", builtin: true })
  })

  it("reflects a user's launch-command override rather than the built-in default", async () => {
    writeState({ "engineCommand.claude": "claudecpa --model opus" })
    const { engines } = (await invokeVerb("engine-list", [], { client: null, runtime })) as {
      engines: Array<{ id: string; command: string }>
    }
    // WYSIWYG: what `engine-list` prints is what a launch runs — an agent
    // copies this string into --command and edits a flag.
    expect(engines.find((e) => e.id === "claude")?.command).toBe("claudecpa --model opus")
  })

  it("lists a registered preset with its declared protocol", async () => {
    writeState({
      customEngineIds: ["pi"],
      "engineCommand.pi": "pi --interactive",
      "engineName.pi": "Pi",
      "engineProtocol.pi": "claude",
    })
    const { engines } = (await invokeVerb("engine-list", [], { client: null, runtime })) as {
      engines: Array<{ id: string; name: string; command: string; protocol: string; builtin: boolean }>
    }
    expect(engines.find((e) => e.id === "pi")).toEqual({
      id: "pi",
      name: "Pi",
      command: "pi --interactive",
      protocol: "claude",
      builtin: false,
    })
  })

  it("a preset registered without a protocol reads as generic, not as claude", async () => {
    writeState({ customEngineIds: ["aider"], "engineCommand.aider": "aider" })
    const { engines } = (await invokeVerb("engine-list", [], { client: null, runtime })) as {
      engines: Array<{ id: string; protocol: string }>
    }
    expect(engines.find((e) => e.id === "aider")?.protocol).toBe(GENERIC_PROTOCOL)
  })
})

describe("protocol resolution from a raw command", () => {
  it("a preset id resolves to its declared protocol", () => {
    writeState({ customEngineIds: ["pi"], "engineCommand.pi": "pi", "engineProtocol.pi": "codex" })
    expect(resolveCommandProtocol("pi")).toBe("codex")
  })

  it("a preset id wins over a coincidental binary of the same name", () => {
    // `claude` here is a REGISTERED preset declaring the codex protocol; the
    // id lookup must run before the argv walk that would say "claude".
    writeState({
      customEngineIds: ["myclaude"],
      "engineCommand.myclaude": "claude",
      "engineProtocol.myclaude": "codex",
    })
    expect(resolveCommandProtocol("myclaude")).toBe("codex")
  })

  it("a built-in binary resolves through wrappers, as the process probe does", () => {
    writeState({})
    expect(resolveCommandProtocol("claude --model opus")).toBe("claude")
    expect(resolveCommandProtocol("env FOO=1 codex")).toBe("codex")
  })

  it("a command line matching a preset's OWN command inherits its protocol", () => {
    writeState({ customEngineIds: ["pi"], "engineCommand.pi": "pi-cli --interactive", "engineProtocol.pi": "claude" })
    expect(resolveCommandProtocol("pi-cli --other-flag")).toBe("claude")
  })

  it("an unrecognisable command is generic — never a guessed vendor", () => {
    writeState({})
    expect(resolveCommandProtocol("some-random-agent --go")).toBe(GENERIC_PROTOCOL)
    expect(resolveCommandProtocol("")).toBe(GENERIC_PROTOCOL)
  })

  it("only lists ids that are actually registered", () => {
    writeState({ customEngineIds: ["pi"] })
    expect(listEnginePresets().map((p) => p.id)).toEqual([...ALL_VENDORS, "pi"])
  })
})

describe("the dispatch face takes a command, not an engine enum", () => {
  it("`add --command` carries a registered preset id through to task.create", async () => {
    writeState({ customEngineIds: ["pi"], "engineCommand.pi": "pi", "engineProtocol.pi": "claude" })
    const client = new FakeClient({ "task.create": () => ({ taskId: "t9", task: taskFixture({ id: "t9" }) }) })
    await invokeVerb("add", ["--repo", "/repo/x", "--command", "pi"], { client, runtime })
    // The ID is recorded, not its expansion — so a later Settings edit of
    // `engineCommand.pi` still reaches this task.
    expect(client.requests[0]?.payload).toMatchObject({ command: "pi", vendor: "claude" })
  })

  it("`add --command` takes a raw command line no registry knows", async () => {
    writeState({})
    const client = new FakeClient({ "task.create": () => ({ taskId: "t9", task: taskFixture({ id: "t9" }) }) })
    await invokeVerb("add", ["--repo", "/repo/x", "--command", "aider --model sonnet"], { client, runtime })
    expect(client.requests[0]?.payload).toMatchObject({ command: "aider --model sonnet", vendor: GENERIC_PROTOCOL })
  })

  it("--command is a plain string: no enum to reject an unfamiliar engine", () => {
    const flags = verbSchema(findVerb("add")!) as { flags: Array<{ name: string; type: string; values?: string[] }> }
    const command = flags.flags.find((f) => f.name === "command")
    expect(command?.type).toBe("string")
    expect(command?.values).toBeUndefined()
    // ... and the retired flag is gone from the dispatch verbs entirely.
    expect(flags.flags.some((f) => f.name === "vendor")).toBe(false)
  })
})

describe("--vendor discovery on the surfaces that still use it", () => {
  function vendorValues(detail: unknown): string[] {
    const flags = (detail as { flags: { name: string; values?: string[] }[] }).flags
    return flags.find((f) => f.name === "vendor")?.values ?? []
  }

  it("verbSchema lists registered custom engines in --vendor values", () => {
    writeState({ customEngineIds: ["claudecpa"] })
    const detail = verbSchema(findVerb("workitem-start")!)
    expect(vendorValues(detail)).toContain("claudecpa")
    expect(vendorValues(detail)).toContain("claude")
  })

  it("--help text shows the custom engine in the enum brace list", () => {
    writeState({ customEngineIds: ["claudecpa"] })
    expect(verbHelp(findVerb("workitem-start")!)).toMatch(/--vendor \{[^}]*\bclaudecpa\b[^}]*\}/)
  })

  it("lists only built-ins when no custom engine is registered", () => {
    writeState({})
    expect(vendorValues(verbSchema(findVerb("workitem-start")!))).toEqual([...ALL_VENDORS])
  })
})
