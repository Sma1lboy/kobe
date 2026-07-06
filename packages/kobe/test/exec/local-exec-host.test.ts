import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type ExecResult, LocalExecHost, RemoteExecHost, type RemoteSpec } from "../../src/exec/exec-host.ts"

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kobe-local-exec-"))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("LocalExecHost", () => {
  const host = new LocalExecHost()

  it("is local, wraps commands as identity, and ensureReady is a no-op", () => {
    expect(host.isRemote).toBe(false)
    expect(host.wrapCommand("echo hi")).toBe("echo hi")
    expect(() => host.ensureReady()).not.toThrow()
  })

  it("run executes in the given cwd with merged env and captures stdout", async () => {
    const result = await host.run(["sh", "-c", "printf '%s' \"$KOBE_PROBE:$(pwd)\""], {
      cwd: dir,
      env: { KOBE_PROBE: "yes" },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.startsWith("yes:")).toBe(true)
    expect(result.stdout).toContain("kobe-local-exec-")
  })

  it("run captures stderr and non-zero exit codes without throwing", async () => {
    const result = await host.run(["sh", "-c", "echo oops >&2; exit 3"])
    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain("oops")
  })

  it("run degrades a missing binary to exitCode -1 (spawn error, no throw)", async () => {
    const result = await host.run(["definitely-not-a-binary-xyz"])
    expect(result.exitCode).toBe(-1)
  })

  it("fs helpers: exists / mkdirp / readFile / readdir with graceful fallbacks", async () => {
    const sub = join(dir, "a/b/c")
    await host.mkdirp(sub)
    expect(await host.exists(sub)).toBe(true)
    expect(await host.exists(join(dir, "nope"))).toBe(false)

    writeFileSync(join(sub, "f.txt"), "content")
    expect(await host.readFile(join(sub, "f.txt"))).toBe("content")
    expect(await host.readFile(join(dir, "missing.txt"))).toBeNull()

    expect(await host.readdir(sub)).toEqual(["f.txt"])
    expect(await host.readdir(join(dir, "missing-dir"))).toEqual([])
  })
})

describe("RemoteExecHost residual branches", () => {
  const spec = (auth: RemoteSpec["auth"]): RemoteSpec => ({
    host: "box",
    user: "dev",
    port: 22,
    auth,
    controlPath: "/tmp/cm-sock",
  })

  function recordingSpawner(results: Partial<Record<string, ExecResult>> = {}) {
    const calls: string[][] = []
    const spawn = (argv: readonly string[], _env?: Record<string, string>): ExecResult => {
      calls.push([...argv])
      const key = argv[argv.length - 1] ?? ""
      return results[key] ?? { stdout: "", stderr: "", exitCode: argv.includes("-O") ? 1 : 0 }
    }
    return { calls, spawn }
  }

  it("readdir parses ls -1 output and degrades a failure to []", async () => {
    const { spawn } = recordingSpawner({ "'ls' '-1A' '/srv/dir'": { stdout: "a\nb\n\n", stderr: "", exitCode: 0 } })
    const host = new RemoteExecHost(spec({ kind: "key", keyPath: "/id" }), spawn)
    expect(await host.readdir("/srv/dir")).toEqual(["a", "b"])

    const failing = new RemoteExecHost(spec({ kind: "key", keyPath: "/id" }), () => ({
      stdout: "",
      stderr: "err",
      exitCode: 1,
    }))
    expect(await failing.readdir("/srv/dir")).toEqual([])
  })

  it("a null password from the keychain falls back to plain ssh (no sshpass)", () => {
    const { calls, spawn } = recordingSpawner()
    const host = new RemoteExecHost(spec({ kind: "password", getPassword: () => null }), spawn)
    host.ensureReady()
    const bringUp = calls[calls.length - 1]
    expect(bringUp?.[0]).toBe("ssh")
    expect(calls.some((c) => c[0] === "sshpass")).toBe(false)
  })
})
