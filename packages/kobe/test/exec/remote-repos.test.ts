import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execHostForRepo, remoteSpecFromConfig } from "../../src/exec/resolve.ts"
import {
  addRemoteRepo,
  getRemoteRepoConfig,
  getSavedRepos,
  isRemoteRepoKey,
  remoteRepoKey,
  resolveRepoRoot,
} from "../../src/state/repos.ts"

let home: string
const ORIGINAL = process.env.KOBE_HOME_DIR

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kobe-remote-"))
  process.env.KOBE_HOME_DIR = home
})

afterEach(() => {
  if (ORIGINAL === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = ORIGINAL
})

describe("remoteRepoKey / isRemoteRepoKey", () => {
  it("encodes ssh://user@host[:port] and round-trips through resolveRepoRoot", () => {
    expect(remoteRepoKey("box", "dev", 2222)).toBe("ssh://dev@box:2222")
    expect(remoteRepoKey("box", "dev")).toBe("ssh://dev@box")
    expect(isRemoteRepoKey("ssh://dev@box")).toBe(true)
    expect(isRemoteRepoKey("/Users/dev/proj")).toBe(false)
    // resolveRepoRoot must NOT canonicalize a remote key (no local path to ask git about).
    expect(resolveRepoRoot("ssh://dev@box:2222")).toBe("ssh://dev@box:2222")
  })
})

describe("addRemoteRepo", () => {
  it("stores the config and adds the synthetic key to savedRepos", () => {
    const { key, added } = addRemoteRepo({
      host: "box",
      user: "dev",
      port: 2222,
      basePath: "/srv/work",
      auth: { kind: "key", keyPath: "/home/dev/.ssh/id" },
    })
    expect(key).toBe("ssh://dev@box:2222")
    expect(added).toBe(true)
    expect(getSavedRepos()).toContain("ssh://dev@box:2222")
    expect(getRemoteRepoConfig(key)?.basePath).toBe("/srv/work")
  })

  it("is idempotent on savedRepos but overwrites the config", () => {
    addRemoteRepo({ host: "box", user: "dev", basePath: "/a", auth: { kind: "key" } })
    const second = addRemoteRepo({ host: "box", user: "dev", basePath: "/b", auth: { kind: "key" } })
    expect(second.added).toBe(false)
    expect(getSavedRepos().filter((r) => r === "ssh://dev@box")).toHaveLength(1)
    expect(getRemoteRepoConfig("ssh://dev@box")?.basePath).toBe("/b")
  })
})

describe("execHostForRepo", () => {
  it("returns a LocalExecHost for an ordinary path", () => {
    expect(execHostForRepo("/Users/dev/proj").isRemote).toBe(false)
  })

  it("returns a RemoteExecHost for a registered remote key", () => {
    addRemoteRepo({ host: "box", user: "dev", basePath: "/srv", auth: { kind: "key" } })
    expect(execHostForRepo("ssh://dev@box").isRemote).toBe(true)
  })

  it("falls back to local for an ssh:// key with no stored config", () => {
    expect(execHostForRepo("ssh://ghost@nowhere").isRemote).toBe(false)
  })
})

describe("remoteSpecFromConfig", () => {
  it("derives the control socket under KOBE_HOME and maps key auth", () => {
    const spec = remoteSpecFromConfig({
      host: "box",
      user: "dev",
      port: 22,
      basePath: "/srv",
      auth: { kind: "key", keyPath: "/k" },
    })
    expect(spec.controlPath.startsWith(home)).toBe(true)
    expect(spec.controlPath.endsWith(".sock")).toBe(true)
    expect(spec.auth).toEqual({ kind: "key", keyPath: "/k" })
  })

  it("password auth exposes a lazy getter, not the secret", () => {
    const spec = remoteSpecFromConfig({
      host: "box",
      user: "dev",
      basePath: "/srv",
      auth: { kind: "password", keychainRef: { service: "kobe-remote-ssh", account: "dev@box" } },
    })
    expect(spec.auth.kind).toBe("password")
    if (spec.auth.kind === "password") {
      // No keychain item exists in this temp env → getter yields null, never throws.
      expect(spec.auth.getPassword()).toBeNull()
    }
  })
})
