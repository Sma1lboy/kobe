import { describe, expect, it } from "vitest"
import {
  type ExecResult,
  LocalExecHost,
  RemoteExecHost,
  type RemoteSpec,
  type Spawner,
  remoteShellCommand,
  shJoin,
  shQuote,
  sshConnectArgs,
} from "../../src/exec/exec-host.ts"

const KEY_SPEC: RemoteSpec = {
  host: "box.example.com",
  user: "dev",
  port: 2222,
  auth: { kind: "key", keyPath: "/home/dev/.ssh/id_ed25519" },
  controlPath: "/tmp/kobe/ssh/box.sock",
}

const PW_SPEC: RemoteSpec = {
  host: "box.example.com",
  user: "dev",
  auth: { kind: "password", getPassword: () => "hunter2" },
  controlPath: "/tmp/kobe/ssh/box.sock",
}

/** Records every spawn so a test can assert the exact argv/env without a real ssh. */
function recordingSpawner(result: ExecResult = { stdout: "", stderr: "", exitCode: 0 }) {
  const calls: Array<{ argv: string[]; env?: Record<string, string> }> = []
  const spawn: Spawner = (argv, env) => {
    calls.push({ argv: [...argv], env })
    return result
  }
  return { spawn, calls }
}

describe("shQuote / shJoin", () => {
  it("single-quotes a plain string", () => {
    expect(shQuote("hello")).toBe("'hello'")
  })

  it("escapes embedded single quotes the POSIX way", () => {
    // a'b → 'a'\''b'
    expect(shQuote("a'b")).toBe("'a'\\''b'")
  })

  it("quotes each argv element and space-joins", () => {
    expect(shJoin(["git", "status", "--porcelain"])).toBe("'git' 'status' '--porcelain'")
  })
})

describe("remoteShellCommand", () => {
  it("prefixes cd <cwd> when a cwd is given", () => {
    expect(remoteShellCommand(["git", "status"], "/srv/wt")).toBe("cd '/srv/wt' && 'git' 'status'")
  })

  it("omits the cd when no cwd is given", () => {
    expect(remoteShellCommand(["git", "status"])).toBe("'git' 'status'")
  })
})

describe("sshConnectArgs", () => {
  it("builds the multiplexed connection argv with port + key", () => {
    expect(sshConnectArgs(KEY_SPEC)).toEqual([
      "ssh",
      "-o",
      "ControlMaster=auto",
      "-o",
      "ControlPath=/tmp/kobe/ssh/box.sock",
      "-o",
      "ControlPersist=300",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-p",
      "2222",
      "-i",
      "/home/dev/.ssh/id_ed25519",
      "dev@box.example.com",
    ])
  })

  it("adds -tt for a tty launch and BatchMode for a batch call", () => {
    expect(sshConnectArgs(KEY_SPEC, { tty: true })).toContain("-tt")
    expect(sshConnectArgs(KEY_SPEC, { batch: true })).toContain("BatchMode=yes")
  })

  it("uses TOFU (accept-new), never StrictHostKeyChecking=no", () => {
    const argv = sshConnectArgs(KEY_SPEC)
    expect(argv).toContain("StrictHostKeyChecking=accept-new")
    expect(argv).not.toContain("StrictHostKeyChecking=no")
  })

  it("omits -p / -i when no port / key is configured", () => {
    const argv = sshConnectArgs(PW_SPEC)
    expect(argv).not.toContain("-p")
    expect(argv).not.toContain("-i")
  })
})

describe("RemoteExecHost.run", () => {
  it("opens the master once then reuses it, wrapping argv as ssh + remote command", async () => {
    const { spawn, calls } = recordingSpawner()
    const host = new RemoteExecHost(KEY_SPEC, spawn)

    await host.run(["git", "status"], { cwd: "/srv/wt" })

    // First call: `-O check` (master probe). It returns exit 0 here, so the
    // master is considered up and no -fN bring-up happens.
    expect(calls[0]?.argv).toContain("-O")
    expect(calls[0]?.argv).toContain("check")

    // Second call: the actual command over the multiplexed connection.
    const runCall = calls[1]
    expect(runCall?.argv[0]).toBe("ssh")
    expect(runCall?.argv).toContain("BatchMode=yes")
    expect(runCall?.argv.at(-1)).toBe("cd '/srv/wt' && 'git' 'status'")
    // No sshpass on a per-call command — the master carries the channel.
    expect(runCall?.argv).not.toContain("sshpass")

    // A second run reuses the master: no further `-O check`.
    await host.run(["git", "log"])
    const checks = calls.filter((c) => c.argv.includes("check"))
    expect(checks).toHaveLength(1)
  })

  it("prefixes safe env vars into the remote command", async () => {
    const { spawn, calls } = recordingSpawner()
    const host = new RemoteExecHost(KEY_SPEC, spawn)

    await host.run(["git", "status"], {
      cwd: "/srv/wt",
      env: { GIT_OPTIONAL_LOCKS: "0", "bad-key": "ignored" },
    })

    expect(calls[1]?.argv.at(-1)).toBe("cd '/srv/wt' && GIT_OPTIONAL_LOCKS='0' 'git' 'status'")
  })

  // A cached RemoteExecHost (exec/resolve.ts) lives for the whole daemon
  // process, so a dropped/expired ControlPersist socket must self-heal
  // instead of leaving `masterUp` confidently (and permanently) wrong.
  it("self-heals: an ssh-level failure (exit 255) resets masterUp so the next run() re-checks", async () => {
    let exitCode = 0
    const calls: string[][] = []
    const spawn: Spawner = (argv) => {
      calls.push([...argv])
      return { stdout: "", stderr: "", exitCode }
    }
    const host = new RemoteExecHost(KEY_SPEC, spawn)

    await host.run(["git", "status"]) // master probe (exit 0) + the command
    expect(calls.filter((c) => c.includes("check"))).toHaveLength(1)

    exitCode = 255 // simulate the multiplexed socket dying mid-command
    await host.run(["git", "status"])
    expect(calls.filter((c) => c.includes("check"))).toHaveLength(1) // still cached — this run() itself failed

    exitCode = 0
    await host.run(["git", "status"])
    // masterUp was reset by the 255 above → this run() re-probes before the command.
    expect(calls.filter((c) => c.includes("check"))).toHaveLength(2)
  })

  it("a remote command's own non-zero exit (not ssh's) does NOT reset masterUp", async () => {
    const { spawn, calls } = recordingSpawner({ stdout: "", stderr: "not found", exitCode: 1 })
    const host = new RemoteExecHost(KEY_SPEC, spawn)

    await host.run(["git", "status"])
    await host.run(["git", "status"])
    // Both runs' remote command failed with exit 1 (a real git error, not an
    // ssh-transport failure) — still only ONE `-O check` across both calls.
    expect(calls.filter((c) => c.argv.includes("check"))).toHaveLength(1)
  })
})

describe("RemoteExecHost master bring-up (password)", () => {
  it("brings up the master with sshpass -e + SSHPASS env, never -p, when the probe fails", () => {
    // `-O check` fails (exit 1) → master must be opened.
    let first = true
    const calls: Array<{ argv: string[]; env?: Record<string, string> }> = []
    const spawn: Spawner = (argv, env) => {
      calls.push({ argv: [...argv], env })
      if (first && argv.includes("check")) {
        first = false
        return { stdout: "", stderr: "", exitCode: 1 }
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    }
    const host = new RemoteExecHost(PW_SPEC, spawn)
    host.ensureReady()

    const bringUp = calls.find((c) => c.argv[0] === "sshpass")
    expect(bringUp).toBeDefined()
    expect(bringUp?.argv).toEqual(expect.arrayContaining(["sshpass", "-e"]))
    // The password rides in the env, NEVER on argv (-p leaks via ps).
    expect(bringUp?.argv).not.toContain("-p")
    expect(bringUp?.argv).not.toContain("hunter2")
    expect(bringUp?.env?.SSHPASS).toBe("hunter2")
    // -fN backgrounded master.
    expect(bringUp?.argv).toContain("-fN")
  })
})

describe("RemoteExecHost.wrapCommand", () => {
  it("produces an ssh PTY launch line with no secret in it", () => {
    const { spawn } = recordingSpawner()
    const host = new RemoteExecHost(PW_SPEC, spawn)
    const line = host.wrapCommand("claude", { tty: true, cwd: "/srv/wt" })

    expect(line.startsWith("ssh ")).toBe(true)
    expect(line).toContain("-tt")
    expect(line).toContain("dev@box.example.com")
    // The remote half is single-quoted as one arg for the local shell.
    expect(line).toContain("'cd '\\''/srv/wt'\\'' && claude'")
    // No password, no sshpass — the pane command must never carry a secret.
    expect(line).not.toContain("sshpass")
    expect(line).not.toContain("hunter2")
  })

  it("quotes a key path containing a space so the local shell keeps it as one arg", () => {
    const { spawn } = recordingSpawner()
    const spec: RemoteSpec = {
      ...KEY_SPEC,
      auth: { kind: "key", keyPath: "/home/dev/my keys/id_ed25519" },
    }
    const line = new RemoteExecHost(spec, spawn).wrapCommand("claude", { tty: true, cwd: "/srv/wt" })
    // The space-bearing path is single-quoted as a whole; bare flags stay bare.
    expect(line).toContain("'/home/dev/my keys/id_ed25519'")
    expect(line.startsWith("ssh ")).toBe(true)
    expect(line).toContain("dev@box.example.com")
  })
})

describe("RemoteExecHost fs helpers", () => {
  it("maps exists/readFile/readdir to remote shell commands", async () => {
    const responses: Record<string, ExecResult> = {
      test: { stdout: "", stderr: "", exitCode: 0 },
      cat: { stdout: "file body", stderr: "", exitCode: 0 },
      ls: { stdout: "a\nb\n.git\n", stderr: "", exitCode: 0 },
    }
    const spawn: Spawner = (argv) => {
      const remote = argv.at(-1) ?? ""
      if (remote.includes("'test'")) return responses.test!
      if (remote.includes("'cat'")) return responses.cat!
      if (remote.includes("'ls'")) return responses.ls!
      return { stdout: "", stderr: "", exitCode: 0 }
    }
    const host = new RemoteExecHost(KEY_SPEC, spawn)

    await expect(host.exists("/srv/wt/.git")).resolves.toBe(true)
    await expect(host.readFile("/srv/wt/README.md")).resolves.toBe("file body")
    await expect(host.readdir("/srv/wt")).resolves.toEqual(["a", "b", ".git"])
  })
})

describe("LocalExecHost.run (async, non-blocking)", () => {
  it("resolves with stdout and exit code 0 on success", async () => {
    const host = new LocalExecHost()
    const r = await host.run(["printf", "out"])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("out")
    expect(r.stderr).toBe("")
  })

  it("resolves (never rejects) with the non-zero exit code and stderr", async () => {
    const host = new LocalExecHost()
    const r = await host.run(["sh", "-c", "echo oops >&2; exit 3"])
    expect(r.exitCode).toBe(3)
    expect(r.stderr).toContain("oops")
  })

  it("maps a missing binary (ENOENT) to the old spawnSync-derived shape: exitCode -1, empty output", async () => {
    const host = new LocalExecHost()
    const r = await host.run(["kobe-definitely-not-a-real-binary-xyz"])
    expect(r.exitCode).toBe(-1)
    expect(r.stdout).toBe("")
    expect(r.stderr).toBe("")
  })

  it("does not block the event loop while the subprocess runs", async () => {
    // The daemon-freeze regression pin: with the old spawnSync impl a timer
    // could never fire while a command ran. Start a 300ms subprocess, then
    // prove a 50ms timer resolves FIRST — i.e. the event loop kept turning.
    const host = new LocalExecHost()
    const order: string[] = []
    const runP = host.run(["sleep", "0.3"]).then((r) => {
      order.push("run")
      return r
    })
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        order.push("timer")
        resolve()
      }, 50),
    )
    const r = await runP
    expect(order).toEqual(["timer", "run"])
    expect(r.exitCode).toBe(0)
  })
})
