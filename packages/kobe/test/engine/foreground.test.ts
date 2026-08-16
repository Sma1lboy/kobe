import { describe, expect, it } from "vitest"
import {
  engineProcessIn,
  foregroundEngine,
  foregroundEngineIn,
  hasAncestor,
  parsePsSnapshot,
  vendorFromArgv,
} from "../../src/engine/foreground.ts"

/**
 * Verbatim `ps -A -o pid=,ppid=,args=` lines captured while the owner's
 * `claudecpa` zsh function ran in a real PTY (2026-07-27): the shell
 * spawns cc-switch's `/bin/sh -c` wrapper, which spawns the actual
 * claude binary two levels down.
 */
const REAL_TREE = `
56070     1 -zsh
56142 56070 /bin/sh -c claude_bin="$1"; settings_path="$2"; shift 2; exit_status=0
56143 56142 /opt/homebrew/bin/claude --settings /var/folders/dg/T/cc-switch-claude-cliproxy-claude-pool-56142.json --model claude-opus-5[1m] --dangerously-skip-permissions
56201 56143 bun /Users/jacksonc/claude-peers-mcp/server.ts
`

describe("vendorFromArgv", () => {
  it("identifies an engine by its executable, ignoring arguments", () => {
    expect(vendorFromArgv("/opt/homebrew/bin/claude --model opus")).toBe("claude")
    expect(vendorFromArgv("codex --dangerously-bypass-approvals-and-sandbox")).toBe("codex")
    // The launcher-suffixed binary claude actually execs.
    expect(vendorFromArgv("/opt/node_modules/@anthropic-ai/claude-code/bin/claude.exe daemon run")).toBe("claude")
  })

  it("does NOT identify from arguments — the title heuristic's bug", () => {
    // cc-switch IS the process; its claude child is what identifies.
    expect(vendorFromArgv("cc-switch start claude cliproxy-claude-pool -- --model x")).toBeNull()
    // A path that merely contains an engine name must not match.
    expect(vendorFromArgv("vim /Users/jacksonc/i/codefox/src/codex-notes.ts")).toBeNull()
  })

  it("sees through interpreters", () => {
    expect(vendorFromArgv("node /usr/local/lib/codex/bin/codex.js")).toBe("codex")
    expect(vendorFromArgv("env FOO=1 claude")).toBe("claude")
  })

  it("identifies kimi by its rewritten process title (registry processNames)", () => {
    // Verbatim `ps -o args=` lines from two live kimi sessions (2026-08-15):
    // the Mach-O launcher rewrites argv[0] to `kimi-co`, and what follows is
    // environ memory, not arguments.
    expect(vendorFromArgv("kimi-co NVM_RC_VERSION=")).toBe("kimi")
    expect(vendorFromArgv("kimi-co SSH_AUTH_SOCK=/private/tmp/com.apple.launchd.x/Listeners")).toBe("kimi")
  })

  it("returns null for a plain shell or unrelated process", () => {
    expect(vendorFromArgv("-zsh")).toBeNull()
    expect(vendorFromArgv("")).toBeNull()
  })
})

describe("foregroundEngineIn", () => {
  const rows = parsePsSnapshot(REAL_TREE)

  it("finds the engine under a wrapper the user's alias spawned", () => {
    const found = foregroundEngineIn(rows, 56070)
    expect(found?.vendor).toBe("claude")
    expect(found?.pid).toBe(56143)
  })

  it("is null for a shell sitting at its prompt", () => {
    expect(foregroundEngineIn(rows, 56201)).toBeNull()
    expect(foregroundEngineIn(rows, 99999)).toBeNull()
  })

  it("prefers the shallowest engine — a session, not its helper subprocesses", () => {
    const nested = parsePsSnapshot(`
10 1 -zsh
11 10 claude
12 11 claude bg-pty-host --bg-pty-host /tmp/x.sock
`)
    expect(foregroundEngineIn(nested, 10)?.pid).toBe(11)
  })
})

describe("engineProcessIn (delivery foreground gate)", () => {
  it("sees a builtin engine through the wrapper chain", () => {
    expect(engineProcessIn(parsePsSnapshot(REAL_TREE), 56070)).toBe(true)
  })

  it("a keepAlive fallback shell (engine exited) is NOT an engine", () => {
    const rows = parsePsSnapshot(`
10 1 -zsh
11 10 /bin/sh
`)
    expect(engineProcessIn(rows, 10)).toBe(false)
  })

  it("a DIFFERENT builtin than the task's vendor still passes (cross-vendor send)", () => {
    const rows = parsePsSnapshot(`
10 1 -zsh
11 10 codex
`)
    // caller passed claude's bin; the running codex is still an engine
    expect(engineProcessIn(rows, 10, "claude")).toBe(true)
  })

  it("a live kimi session passes the gate despite its rewritten title", () => {
    const rows = parsePsSnapshot(`
10 1 -zsh
11 10 /bin/bash -ilc kimi -y
12 11 kimi-co NVM_RC_VERSION=
`)
    expect(engineProcessIn(rows, 10, "kimi")).toBe(true)
  })

  it("extraBin matches a custom engine binary the builtin walk cannot see", () => {
    const rows = parsePsSnapshot(`
10 1 -zsh
11 10 /usr/local/bin/aider --model gpt
`)
    expect(engineProcessIn(rows, 10)).toBe(false)
    expect(engineProcessIn(rows, 10, "aider")).toBe(true)
  })
})

describe("foregroundEngine", () => {
  it("reads the snapshot it is given", async () => {
    expect(await foregroundEngine(56070, async () => REAL_TREE)).toMatchObject({ vendor: "claude" })
  })

  it("returns null when ps fails — never a guess", async () => {
    expect(
      await foregroundEngine(56070, () => {
        throw new Error("ps: command not found")
      }),
    ).toBeNull()
  })
})

describe("hasAncestor (issue #24: env inherits, a pid chain doesn't)", () => {
  // A tab shell (10) → engine (11) → its tool shell (12) → this CLI (13),
  // plus a sibling (20) that detached out of the same shell days ago and
  // reparented to init — it still carries the tab's exported env.
  const rows = parsePsSnapshot(`
10 1 /bin/zsh -il
11 10 claude
12 11 /bin/zsh -c kobe api add
13 12 bun /kobe/api add
20 1 claude --fork-session
`)

  it("is true for a real in-tab call at any depth, and for the shell itself", () => {
    expect(hasAncestor(rows, 13, 10)).toBe(true)
    expect(hasAncestor(rows, 11, 10)).toBe(true)
    expect(hasAncestor(rows, 10, 10)).toBe(true)
  })

  it("is false for a detached process that merely inherited the env", () => {
    expect(hasAncestor(rows, 20, 10)).toBe(false)
  })

  it("is false for an unknown pid, and terminates on a cyclic snapshot", () => {
    expect(hasAncestor(rows, 999, 10)).toBe(false)
    expect(hasAncestor(parsePsSnapshot("30 31 a\n31 30 b"), 30, 10)).toBe(false)
  })
})
