/**
 * `runAddRemote` (kobe add --remote) — sibling of add-remote.test.ts (which
 * covers parseRemoteFlags). RemoteExecHost + keychain are mocked (a real one
 * would SSH out / hit the macOS keychain); state.json lives under a
 * KOBE_HOME_DIR tempdir, so registration is asserted against the real
 * persisted remoteRepos entry — not a mocked write.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  isKeychainSupported: vi.fn(() => false),
  setKeychainPassword: vi.fn(() => true),
  getKeychainPassword: vi.fn(() => "pw"),
  remoteKeychainRef: vi.fn((host: string, user: string, port?: number) => `kobe-ssh:${user}@${host}:${port ?? 22}`),
  /** What the mocked hidden-password prompt answers. */
  passwordAnswer: "hunter2",
}))

// promptHidden reads the password through readline against the real tty;
// answer it synchronously so no test ever blocks on stdin.
vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => ({
    question: (_q: string, cb: (answer: string) => void) => cb(mocks.passwordAnswer),
    close: vi.fn(),
  })),
}))

vi.mock("../../src/exec/exec-host.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/exec/exec-host.ts")>()
  return {
    ...actual,
    RemoteExecHost: vi.fn().mockImplementation(() => ({ run: mocks.run })),
  }
})

vi.mock("../../src/exec/keychain.ts", () => ({
  isKeychainSupported: mocks.isKeychainSupported,
  setKeychainPassword: mocks.setKeychainPassword,
  getKeychainPassword: mocks.getKeychainPassword,
  remoteKeychainRef: mocks.remoteKeychainRef,
}))

import { runAddRemote } from "../../src/cli/add-remote.ts"
import { getRemoteRepos, getSavedRepos } from "../../src/state/repos.ts"
import { updateStateFile } from "../../src/state/store.ts"

let home: string
let originalHome: string | undefined
let logSpy: MockInstance<typeof console.log>
let errSpy: MockInstance<typeof process.stderr.write>
let exitSpy: MockInstance<typeof process.exit>

function enableRemoteProjects(): void {
  updateStateFile((state) => {
    ;(state as Record<string, unknown>)["experimental.remoteProjects"] = true
    return undefined
  })
}

beforeEach(() => {
  originalHome = process.env.KOBE_HOME_DIR
  home = mkdtempSync(join(tmpdir(), "kobe-add-remote-"))
  process.env.KOBE_HOME_DIR = home

  mocks.run.mockReset().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" })
  mocks.isKeychainSupported.mockReset().mockReturnValue(false)
  mocks.setKeychainPassword.mockReset().mockReturnValue(true)
  mocks.getKeychainPassword.mockReset().mockReturnValue("pw")

  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`)
  }) as never)
})

afterEach(() => {
  if (originalHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = originalHome
  rmSync(home, { recursive: true, force: true })
  logSpy.mockRestore()
  errSpy.mockRestore()
  exitSpy.mockRestore()
})

function log(): string {
  return logSpy.mock.calls.map((c) => String(c[0])).join("\n")
}
function err(): string {
  return errSpy.mock.calls.map((c) => String(c[0])).join("")
}

describe("runAddRemote gating + validation", () => {
  it("refuses when the experimental flag is off", async () => {
    await expect(runAddRemote(["--host", "h", "--user", "u", "--path", "/srv", "--key"])).rejects.toThrow("exit 2")
    expect(err()).toContain("remote projects are experimental and disabled")
  })

  it("requires host, user, path, and exactly one auth method", async () => {
    enableRemoteProjects()

    await expect(runAddRemote(["--user", "u", "--path", "/srv", "--key"])).rejects.toThrow("exit 2")
    expect(err()).toContain("--host is required")

    errSpy.mockClear()
    await expect(runAddRemote(["--host", "h", "--path", "/srv", "--key"])).rejects.toThrow("exit 2")
    expect(err()).toContain("--user is required")

    errSpy.mockClear()
    await expect(runAddRemote(["--host", "h", "--user", "u", "--key"])).rejects.toThrow("exit 2")
    expect(err()).toContain("--path (remote base path) is required")

    errSpy.mockClear()
    await expect(runAddRemote(["--host", "h", "--user", "u", "--path", "/srv"])).rejects.toThrow("exit 2")
    expect(err()).toContain("an auth method is required")

    errSpy.mockClear()
    await expect(runAddRemote(["--host", "h", "--user", "u", "--path", "/srv", "--key", "--password"])).rejects.toThrow(
      "exit 2",
    )
    expect(err()).toContain("choose ONE of --key or --password")
  })

  it("--password on a platform without keychain support fails", async () => {
    enableRemoteProjects()
    mocks.isKeychainSupported.mockReturnValue(false)
    await expect(runAddRemote(["--host", "h", "--user", "u", "--path", "/srv", "--password"])).rejects.toThrow("exit 2")
    expect(err()).toContain("--password needs the macOS keychain")
  })
})

describe("runAddRemote key-auth registration", () => {
  it("persists the remote repo + savedRepos key and probes the base path", async () => {
    enableRemoteProjects()
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    await runAddRemote(["--host", "box", "--user", "dev", "--path", "/srv/work", "--port", "2222", "--key", "/k"])

    const key = "ssh://dev@box:2222"
    expect(getSavedRepos()).toContain(key)
    expect(getRemoteRepos()[key]).toMatchObject({
      host: "box",
      user: "dev",
      port: 2222,
      basePath: "/srv/work",
      auth: { kind: "key", keyPath: "/k" },
    })
    expect(log()).toContain(`added remote project ${key} (base /srv/work)`)
    // The probe ran `test -d <basePath>` on the (mocked) remote host.
    expect(mocks.run).toHaveBeenCalledWith(["test", "-d", "/srv/work"])
    expect(log()).toContain("ok")
    outSpy.mockRestore()
  })

  it("reports a reachable host whose base path is missing, without unregistering", async () => {
    enableRemoteProjects()
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    mocks.run.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "" })

    await runAddRemote(["--host", "box", "--user", "dev", "--path", "/srv", "--key"])

    expect(log()).toContain('reachable, but base path "/srv" is not a directory')
    expect(getRemoteRepos()["ssh://dev@box"]).toBeDefined()
  })

  it("keeps the project saved when the probe cannot connect", async () => {
    enableRemoteProjects()
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    mocks.run.mockRejectedValue(new Error("connection refused"))

    await runAddRemote(["--host", "box", "--user", "dev", "--path", "/srv", "--key"])

    expect(log()).toContain("could not connect (connection refused)")
    expect(log()).toContain("the project is saved")
    expect(getRemoteRepos()["ssh://dev@box"]).toBeDefined()
  })

  it("--help prints usage and exits 0 without registering anything", async () => {
    enableRemoteProjects()
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    await expect(runAddRemote(["--help"])).rejects.toThrow("exit 0")
    expect(outSpy.mock.calls.join("")).toContain("Usage: kobe add --remote")
    expect(getSavedRepos()).toEqual([])
    outSpy.mockRestore()
  })

  it("an unknown flag is a usage error, exit 2", async () => {
    enableRemoteProjects()
    await expect(runAddRemote(["--frobnicate"])).rejects.toThrow("exit 2")
    expect(err()).toContain('unknown flag "--frobnicate"')
  })
})

describe("runAddRemote password-auth registration", () => {
  beforeEach(() => {
    mocks.isKeychainSupported.mockReturnValue(true)
    mocks.passwordAnswer = "hunter2"
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  })

  it("prompts for the password, stores it in the keychain, and persists only the ref", async () => {
    enableRemoteProjects()

    await runAddRemote(["--host", "box", "--user", "dev", "--path", "/srv", "--password"])

    const ref = "kobe-ssh:dev@box:22"
    expect(mocks.setKeychainPassword).toHaveBeenCalledWith(ref, "hunter2")
    // state.json carries the keychainRef, never the secret.
    const stored = getRemoteRepos()["ssh://dev@box"]
    expect(stored?.auth).toEqual({ kind: "password", keychainRef: ref })
    expect(JSON.stringify(stored)).not.toContain("hunter2")
    // The probe still ran against the (mocked) remote host.
    expect(mocks.run).toHaveBeenCalledWith(["test", "-d", "/srv"])
  })

  it("an empty password aborts with exit 2 before any keychain write", async () => {
    enableRemoteProjects()
    mocks.passwordAnswer = ""
    await expect(runAddRemote(["--host", "box", "--user", "dev", "--path", "/srv", "--password"])).rejects.toThrow(
      "exit 2",
    )
    expect(err()).toContain("empty password")
    expect(mocks.setKeychainPassword).not.toHaveBeenCalled()
    expect(getRemoteRepos()["ssh://dev@box"]).toBeUndefined()
  })

  it("a keychain write failure aborts with exit 2 and registers nothing", async () => {
    enableRemoteProjects()
    mocks.setKeychainPassword.mockReturnValue(false)
    await expect(runAddRemote(["--host", "box", "--user", "dev", "--path", "/srv", "--password"])).rejects.toThrow(
      "exit 2",
    )
    expect(err()).toContain("failed to store the password in the keychain")
    expect(getRemoteRepos()["ssh://dev@box"]).toBeUndefined()
  })
})
