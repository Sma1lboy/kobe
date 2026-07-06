import { describe, expect, it } from "vitest"
import {
  type KeychainDeps,
  type KeychainRef,
  deleteKeychainPassword,
  getKeychainPassword,
  isKeychainSupported,
  remoteKeychainRef,
  setKeychainPassword,
} from "../../src/exec/keychain.ts"

const REF: KeychainRef = { service: "kobe-remote-ssh", account: "dev@box:2222" }

function fakeKeychain(platform = "darwin", store: Record<string, string> = {}) {
  const calls: string[][] = []
  const run: KeychainDeps["run"] = (argv) => {
    calls.push([...argv])
    const [, sub] = argv
    const acct = argv[argv.indexOf("-a") + 1]
    if (sub === "add-generic-password") {
      store[acct!] = argv[argv.indexOf("-w") + 1]!
      return { stdout: "", exitCode: 0 }
    }
    if (sub === "find-generic-password") {
      const v = store[acct!]
      return v === undefined ? { stdout: "", exitCode: 44 } : { stdout: `${v}\n`, exitCode: 0 }
    }
    if (sub === "delete-generic-password") {
      const had = acct! in store
      delete store[acct!]
      return { stdout: "", exitCode: had ? 0 : 44 }
    }
    return { stdout: "", exitCode: 1 }
  }
  return { deps: { run, platform: () => platform } as KeychainDeps, calls, store }
}

describe("remoteKeychainRef", () => {
  it("encodes user@host:port, dropping the port when absent", () => {
    expect(remoteKeychainRef("box", "dev", 2222).account).toBe("dev@box:2222")
    expect(remoteKeychainRef("box", "dev").account).toBe("dev@box")
  })
})

describe("isKeychainSupported", () => {
  it("is true on darwin, false elsewhere", () => {
    expect(isKeychainSupported(fakeKeychain("darwin").deps)).toBe(true)
    expect(isKeychainSupported(fakeKeychain("linux").deps)).toBe(false)
  })
})

describe("set/get/delete round-trip", () => {
  it("stores then reads the same password back without a trailing newline", () => {
    const { deps } = fakeKeychain()
    expect(setKeychainPassword(REF, "hunter2", deps)).toBe(true)
    expect(getKeychainPassword(REF, deps)).toBe("hunter2")
  })

  it("uses -U so a re-store updates instead of erroring", () => {
    const { deps, calls } = fakeKeychain()
    setKeychainPassword(REF, "a", deps)
    setKeychainPassword(REF, "b", deps)
    expect(getKeychainPassword(REF, deps)).toBe("b")
    expect(calls[0]).toContain("-U")
  })

  it("returns null for a missing item", () => {
    const { deps } = fakeKeychain()
    expect(getKeychainPassword(REF, deps)).toBeNull()
  })

  it("deletes an item", () => {
    const { deps } = fakeKeychain()
    setKeychainPassword(REF, "x", deps)
    expect(deleteKeychainPassword(REF, deps)).toBe(true)
    expect(getKeychainPassword(REF, deps)).toBeNull()
  })
})

describe("non-darwin degradation", () => {
  it("set/get/delete are no-ops that report unavailable, never throwing", () => {
    const { deps, calls } = fakeKeychain("linux")
    expect(setKeychainPassword(REF, "x", deps)).toBe(false)
    expect(getKeychainPassword(REF, deps)).toBeNull()
    expect(deleteKeychainPassword(REF, deps)).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
