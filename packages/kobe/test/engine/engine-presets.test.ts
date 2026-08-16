/**
 * `engineLaunchArgv` — what a task or tab actually spawns (issue #30).
 *
 * The subtle rule is the preset-id indirection: `--command claude` must mean
 * "my claude" (the `engineCommand.claude` override I configured in Settings),
 * not a bare `claude` that ignores it. A real command line, by contrast, runs
 * verbatim — but still picks up its protocol's effort + terminal-title flags,
 * the same way a per-vendor override always has.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { engineLaunchArgv, engineLaunchBin } from "../../src/engine/engine-presets.ts"

let home: string
let originalHome: string | undefined

function writeState(state: Record<string, unknown>): void {
  const dir = join(home, ".config", "rove")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "state.json"), JSON.stringify(state), "utf8")
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kobe-engine-presets-"))
  originalHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = home
  writeState({})
})

afterEach(() => {
  if (originalHome === undefined) {
    // biome-ignore lint/performance/noDelete: the var must be truly unset when it started unset.
    delete process.env.KOBE_HOME_DIR
  } else process.env.KOBE_HOME_DIR = originalHome
  rmSync(home, { recursive: true, force: true })
})

describe("engineLaunchArgv", () => {
  it("runs a raw command line verbatim", () => {
    expect(engineLaunchArgv({ command: "aider --model sonnet" })).toEqual(["aider", "--model", "sonnet"])
  })

  it("honours quoting so a flag value with spaces survives", () => {
    expect(engineLaunchArgv({ command: 'claude --append-system-prompt "be terse"' })).toEqual([
      "claude",
      "--append-system-prompt",
      "be terse",
    ])
  })

  it("routes a bare preset id through the user's own launch-command override", () => {
    // The whole point of recording the ID rather than its expansion: editing
    // the command in Settings must still reach every task pinned to it.
    writeState({ "engineCommand.claude": "claudecpa --model opus" })
    expect(engineLaunchArgv({ command: "claude" })).toEqual(["claudecpa", "--model", "opus"])
  })

  it("falls back to the protocol's preset when no command is pinned", () => {
    expect(engineLaunchArgv({ vendor: "codex" })[0]).toBe("codex")
  })

  it("applies the protocol's effort flag to a raw command line too", () => {
    // codex maps effort to `-c model_reasoning_effort=…`; a hand-written
    // codex command line is still a codex launch.
    expect(engineLaunchArgv({ command: "codex --search", effort: "high" })).toEqual([
      "codex",
      "--search",
      "-c",
      "model_reasoning_effort=high",
      "-c",
      'tui.terminal_title=["activity","thread-title"]',
    ])
  })

  it("adds no vendor flags to a command whose protocol is generic", () => {
    expect(engineLaunchArgv({ command: "my-agent --go", effort: "high" })).toEqual(["my-agent", "--go"])
  })

  it("falls back rather than returning an empty argv for a blank command", () => {
    expect(engineLaunchArgv({ command: "   ", vendor: "codex" })[0]).toBe("codex")
  })

  it("engineLaunchBin names the binary a delivery gate should match", () => {
    writeState({ customEngineIds: ["pi"], "engineCommand.pi": "pi-cli --interactive" })
    expect(engineLaunchBin({ command: "pi" })).toBe("pi-cli")
    expect(engineLaunchBin({ command: "aider --model sonnet" })).toBe("aider")
  })
})
