/**
 * Unit tests for `findClaudeBinary`.
 *
 * We don't touch the real filesystem here — the impl supports
 * dependency injection so we can pin every search location to a
 * scripted fixture and assert on the visit order.
 *
 * Why these tests matter:
 *   - The search order is the contract. If a future refactor
 *     accidentally checks Homebrew before $PATH, every developer
 *     who has both installed will silently get the wrong binary.
 *   - The not-found error must list every checked path so the user
 *     can self-diagnose (we tend to discover ten new install
 *     locations a year; the error message is the only debugging
 *     surface).
 */

import {
  type BinaryDiscoveryDeps,
  ClaudeBinaryNotFoundError,
  findClaudeBinary,
} from "@/engine/claude-code-local/binary"
import { describe, expect, it } from "vitest"

function makeDeps(overrides: Partial<BinaryDiscoveryDeps>): {
  deps: BinaryDiscoveryDeps
  attempts: string[]
} {
  const attempts: string[] = []
  const inner: BinaryDiscoveryDeps = {
    fileExists() {
      return false
    },
    env() {
      return undefined
    },
    home() {
      return "/home/user"
    },
    which() {
      return undefined
    },
    readdir() {
      return []
    },
    ...overrides,
  }
  // Wrap fileExists so attempts is recorded *regardless* of which
  // override produced the truthy answer. Without this, an override
  // shadows the recording and our visit-order assertions misfire.
  const deps: BinaryDiscoveryDeps = {
    ...inner,
    fileExists(p) {
      attempts.push(p)
      return inner.fileExists(p)
    },
  }
  return { deps, attempts }
}

describe("findClaudeBinary", () => {
  it("prefers `which` result when claude is on PATH", async () => {
    const { deps } = makeDeps({
      which: () => "/some/shim/claude",
      fileExists: (p) => p === "/some/shim/claude",
    })
    expect(await findClaudeBinary(deps)).toBe("/some/shim/claude")
  })

  it("falls back to ~/.claude/local/claude when PATH lookup fails", async () => {
    const { deps } = makeDeps({
      which: () => undefined,
      fileExists: (p) => p === "/home/user/.claude/local/claude",
    })
    expect(await findClaudeBinary(deps)).toBe("/home/user/.claude/local/claude")
  })

  it("checks $NVM_BIN/claude before nvm versions and homebrew", async () => {
    const { deps, attempts } = makeDeps({
      env: (name) => (name === "NVM_BIN" ? "/active/nvm/bin" : undefined),
      fileExists: (p) => p === "/active/nvm/bin/claude",
    })
    expect(await findClaudeBinary(deps)).toBe("/active/nvm/bin/claude")
    // Confirms .claude/local was checked before NVM_BIN.
    expect(attempts.indexOf("/home/user/.claude/local/claude")).toBeLessThan(attempts.indexOf("/active/nvm/bin/claude"))
  })

  it("scans nvm versions newest-first by directory name", async () => {
    const { deps } = makeDeps({
      readdir: (p) => (p === "/home/user/.nvm/versions/node" ? ["v18.0.0", "v20.10.0", "v18.16.1"] : []),
      fileExists: (p) => p === "/home/user/.nvm/versions/node/v20.10.0/bin/claude",
    })
    expect(await findClaudeBinary(deps)).toBe("/home/user/.nvm/versions/node/v20.10.0/bin/claude")
  })

  it("finds homebrew on Apple Silicon (/opt/homebrew/bin/claude)", async () => {
    const { deps } = makeDeps({
      fileExists: (p) => p === "/opt/homebrew/bin/claude",
    })
    expect(await findClaudeBinary(deps)).toBe("/opt/homebrew/bin/claude")
  })

  it("finds homebrew on Intel macs (/usr/local/bin/claude)", async () => {
    const { deps } = makeDeps({
      fileExists: (p) => p === "/usr/local/bin/claude",
    })
    expect(await findClaudeBinary(deps)).toBe("/usr/local/bin/claude")
  })

  it("checks .bun/bin before bare ~/bin", async () => {
    const { deps, attempts } = makeDeps({
      fileExists: (p) => p === "/home/user/.bun/bin/claude",
    })
    expect(await findClaudeBinary(deps)).toBe("/home/user/.bun/bin/claude")
    expect(attempts.indexOf("/home/user/.bun/bin/claude")).toBeLessThan(
      // ~/bin/claude is the very last fallback, so .bun must have been checked first.
      attempts.indexOf("/home/user/bin/claude") === -1
        ? Number.POSITIVE_INFINITY
        : attempts.indexOf("/home/user/bin/claude"),
    )
  })

  it("throws ClaudeBinaryNotFoundError listing checked paths when nothing matches", async () => {
    const { deps } = makeDeps({})
    let err: unknown
    try {
      await findClaudeBinary(deps)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ClaudeBinaryNotFoundError)
    const e = err as ClaudeBinaryNotFoundError
    // The error must surface the canonical install locations so the
    // user can fix their environment without reading our source.
    expect(e.checkedPaths).toContain("/home/user/.claude/local/claude")
    expect(e.checkedPaths).toContain("/opt/homebrew/bin/claude")
    expect(e.checkedPaths).toContain("/usr/local/bin/claude")
  })
})
