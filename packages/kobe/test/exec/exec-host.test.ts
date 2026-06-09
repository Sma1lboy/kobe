import { describe, expect, it } from "vitest"
import {
  type ExecResult,
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
  it("opens the master once then reuses it, wrapping argv as ssh + remote command", () => {
    const { spawn, calls } = recordingSpawner()
    const host = new RemoteExecHost(KEY_SPEC, spawn)

    host.run(["git", "status"], { cwd: "/srv/wt" })

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
    host.run(["git", "log"])
    const checks = calls.filter((c) => c.argv.includes("check"))
    expect(checks).toHaveLength(1)
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
})

describe("RemoteExecHost fs helpers", () => {
  it("maps exists/readFile/readdir to remote shell commands", () => {
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

    expect(host.exists("/srv/wt/.git")).toBe(true)
    expect(host.readFile("/srv/wt/README.md")).toBe("file body")
    expect(host.readdir("/srv/wt")).toEqual(["a", "b", ".git"])
  })
})
