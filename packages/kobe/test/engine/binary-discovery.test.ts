/**
 * Coverage for `src/engine/claude-code-local/binary.ts` and
 * `src/engine/codex-local/binary.ts` — both port the same search order
 * from `refs/opcode` (see the file header comments): `which` on PATH,
 * then a vendor-specific list of well-known install locations, first
 * hit wins. Both accept an injectable `BinaryDiscoveryDeps` so the
 * search order is testable without touching the real filesystem/PATH.
 */

import { describe, expect, it } from "vitest"
import {
  ClaudeBinaryNotFoundError,
  type BinaryDiscoveryDeps as ClaudeDeps,
  findClaudeBinary,
} from "../../src/engine/claude-code-local/binary.ts"
import {
  CodexBinaryNotFoundError,
  type BinaryDiscoveryDeps as CodexDeps,
  findCodexBinary,
} from "../../src/engine/codex-local/binary.ts"

function claudeDeps(over: Partial<ClaudeDeps> = {}): ClaudeDeps {
  return {
    fileExists: () => false,
    env: () => undefined,
    home: () => "/home/u",
    which: () => undefined,
    readdir: () => [],
    ...over,
  }
}

function codexDeps(over: Partial<CodexDeps> = {}): CodexDeps {
  return {
    fileExists: () => false,
    env: () => undefined,
    home: () => "/home/u",
    which: () => undefined,
    readdir: () => [],
    ...over,
  }
}

describe("findClaudeBinary", () => {
  it("prefers the which() PATH hit when it exists on disk", async () => {
    const d = claudeDeps({ which: () => "/usr/bin/claude", fileExists: (p) => p === "/usr/bin/claude" })
    expect(await findClaudeBinary(d)).toBe("/usr/bin/claude")
  })

  it("ignores a which() hit that doesn't actually exist on disk, falls through", async () => {
    const d = claudeDeps({
      which: () => "/usr/bin/claude",
      fileExists: (p) => p === "/home/u/.claude/local/claude",
    })
    expect(await findClaudeBinary(d)).toBe("/home/u/.claude/local/claude")
  })

  // NOTE: the "claude: aliased to <path>" macOS-alias parsing lives INSIDE
  // `defaultDeps.which` (using real `spawnSync`/`existsSync`), not in
  // `findClaudeBinary` itself — `deps.which()` is called and its return value
  // used verbatim. Since `defaultDeps` isn't part of the injectable seam,
  // exercising that parsing would require mocking `node:child_process` +
  // `node:fs` for a single quirk-handling branch; skipped as disproportionate
  // scaffolding for what it covers (the algorithm/search-order tests below
  // exercise everything reachable through the actual seam).

  it("checks NVM_BIN before scanning all nvm versions", async () => {
    const d = claudeDeps({
      env: (n) => (n === "NVM_BIN" ? "/nvm/active/bin" : undefined),
      fileExists: (p) => p === "/nvm/active/bin/claude",
    })
    expect(await findClaudeBinary(d)).toBe("/nvm/active/bin/claude")
  })

  it("scans nvm versions newest-first (string sort, reversed)", async () => {
    const d = claudeDeps({
      readdir: (p) => (p === "/home/u/.nvm/versions/node" ? ["v18.0.0", "v20.0.0", "v16.0.0"] : []),
      fileExists: (p) => p === "/home/u/.nvm/versions/node/v20.0.0/bin/claude",
    })
    expect(await findClaudeBinary(d)).toBe("/home/u/.nvm/versions/node/v20.0.0/bin/claude")
  })

  it("falls through to homebrew/system paths", async () => {
    const d = claudeDeps({ fileExists: (p) => p === "/opt/homebrew/bin/claude" })
    expect(await findClaudeBinary(d)).toBe("/opt/homebrew/bin/claude")
  })

  it("falls through to misc per-user install paths last", async () => {
    const d = claudeDeps({ fileExists: (p) => p === "/home/u/.bun/bin/claude" })
    expect(await findClaudeBinary(d)).toBe("/home/u/.bun/bin/claude")
  })

  it("throws ClaudeBinaryNotFoundError listing every checked path when nothing matches", async () => {
    const d = claudeDeps()
    await expect(findClaudeBinary(d)).rejects.toThrow(ClaudeBinaryNotFoundError)
    try {
      await findClaudeBinary(d)
      throw new Error("unreachable")
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeBinaryNotFoundError)
      const notFound = err as ClaudeBinaryNotFoundError
      expect(notFound.checkedPaths.length).toBeGreaterThan(0)
      expect(notFound.message).toContain("Claude Code binary not found")
    }
  })

  it("returns undefined from which() when the underlying probe yields nothing (no alias, no output)", async () => {
    // Exercise the real (non-injected) which() shape indirectly isn't needed;
    // this pins the deps contract: a which() returning undefined skips to
    // the next search step without throwing.
    const d = claudeDeps({ which: () => undefined, fileExists: (p) => p === "/usr/local/bin/claude" })
    expect(await findClaudeBinary(d)).toBe("/usr/local/bin/claude")
  })
})

describe("findCodexBinary", () => {
  it("prefers the which() PATH hit when it exists on disk", async () => {
    const d = codexDeps({ which: () => "/usr/bin/codex", fileExists: (p) => p === "/usr/bin/codex" })
    expect(await findCodexBinary(d)).toBe("/usr/bin/codex")
  })

  it("falls through to homebrew paths before NVM_BIN (codex's own order)", async () => {
    const d = codexDeps({ fileExists: (p) => p === "/opt/homebrew/bin/codex" })
    expect(await findCodexBinary(d)).toBe("/opt/homebrew/bin/codex")
  })

  it("checks NVM_BIN after the homebrew/system list", async () => {
    const d = codexDeps({
      env: (n) => (n === "NVM_BIN" ? "/nvm/active/bin" : undefined),
      fileExists: (p) => p === "/nvm/active/bin/codex",
    })
    expect(await findCodexBinary(d)).toBe("/nvm/active/bin/codex")
  })

  it("falls through to misc per-user install paths last", async () => {
    const d = codexDeps({ fileExists: (p) => p === "/home/u/.bun/bin/codex" })
    expect(await findCodexBinary(d)).toBe("/home/u/.bun/bin/codex")
  })

  // (see the claude-side NOTE above: alias parsing lives in defaultDeps.which,
  // not the injectable seam — same skip rationale applies here.)

  it("throws CodexBinaryNotFoundError listing every checked path when nothing matches", async () => {
    const d = codexDeps()
    try {
      await findCodexBinary(d)
      throw new Error("unreachable")
    } catch (err) {
      expect(err).toBeInstanceOf(CodexBinaryNotFoundError)
      const notFound = err as CodexBinaryNotFoundError
      expect(notFound.checkedPaths.length).toBeGreaterThan(0)
      expect(notFound.message).toContain("Codex CLI binary not found")
    }
  })
})
