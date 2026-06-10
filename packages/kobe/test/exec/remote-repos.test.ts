import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { kvStatePath } from "../../src/env.ts"
import {
  execHostForRepo,
  localSpawnCwd,
  remoteKeyForRepo,
  remoteSpecFromConfig,
  worktreeUsable,
} from "../../src/exec/resolve.ts"
import {
  addRemoteRepo,
  getRemoteRepoConfig,
  getSavedRepos,
  isRemoteProjectsEnabled,
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

describe("isRemoteProjectsEnabled", () => {
  function writeState(obj: Record<string, unknown>): void {
    const p = kvStatePath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(obj), "utf8")
  }

  it("is false by default / when the key is absent or not exactly true", () => {
    expect(isRemoteProjectsEnabled()).toBe(false)
    writeState({ "experimental.remoteProjects": false })
    expect(isRemoteProjectsEnabled()).toBe(false)
    writeState({ "experimental.remoteProjects": "1" })
    expect(isRemoteProjectsEnabled()).toBe(false)
  })

  it("is true only when the flag is the boolean true", () => {
    writeState({ "experimental.remoteProjects": true })
    expect(isRemoteProjectsEnabled()).toBe(true)
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

// The intent-named seam queries: callers around ensureSession/spawning ask
// these instead of deriving remoteness per call site (`isRemoteRepoKey(...)
// ? repo : undefined`, `.isRemote || existsSync`, `.isRemote ? homeDir() :
// cwd`). A third adapter must only change `exec/`, never the call sites.
describe("remoteKeyForRepo", () => {
  it("passes a remote ssh:// key through and drops local/absent repos", () => {
    expect(remoteKeyForRepo("ssh://dev@box:2222")).toBe("ssh://dev@box:2222")
    expect(remoteKeyForRepo("/Users/dev/proj")).toBeUndefined()
    expect(remoteKeyForRepo(undefined)).toBeUndefined()
    expect(remoteKeyForRepo("")).toBeUndefined()
  })
})

describe("worktreeUsable", () => {
  it("local paths keep the real on-disk check", () => {
    expect(worktreeUsable(home)).toBe(true) // the temp home exists
    expect(worktreeUsable(join(home, "definitely-missing"))).toBe(false)
  })

  it("a path under a remote project's basePath is trusted without a local stat", () => {
    addRemoteRepo({ host: "box", user: "dev", basePath: "/srv/work", auth: { kind: "key" } })
    // Doesn't exist locally — must still be usable (it lives on the remote).
    expect(worktreeUsable("/srv/work/kobe-task-1")).toBe(true)
  })
})

describe("localSpawnCwd", () => {
  it("is the identity for a local worktree", () => {
    expect(localSpawnCwd(home)).toBe(home)
  })

  it("falls back to the local home dir for a remote worktree path", () => {
    addRemoteRepo({ host: "box", user: "dev", basePath: "/srv/work", auth: { kind: "key" } })
    // KOBE_HOME_DIR (= the temp home) overrides os.homedir() in env.homeDir().
    expect(localSpawnCwd("/srv/work/kobe-task-1")).toBe(home)
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
