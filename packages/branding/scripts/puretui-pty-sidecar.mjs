import { spawn as spawnChild } from "node:child_process"
import { createInterface } from "node:readline"
import { pathToFileURL } from "node:url"
import { basename, join, resolve } from "node:path"

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

const inheritedEnvironment = (environment) =>
  Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        value !== undefined &&
        !key.startsWith("KOBE_") &&
        key !== "HOME" &&
        key !== "USERPROFILE" &&
        !key.startsWith("XDG_") &&
        key !== "TERM" &&
        key !== "TERM_PROGRAM" &&
        key !== "TERM_PROGRAM_VERSION" &&
        key !== "COLORTERM",
    ),
  )

const isolatedEnvironment = (baseEnv, demoRoot) => {
  const home = join(demoRoot, "home")
  return {
    ...inheritedEnvironment(baseEnv),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_RUNTIME_DIR: join(home, ".runtime"),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "kobe-capture",
    KOBE_HOME_DIR: home,
    KOBE_SANDBOX_HOME_DIR: home,
    KOBE_DAEMON_WEB_PORT: baseEnv.KOBE_DAEMON_WEB_PORT ?? "5274",
    KOBE_CAPTURE_HOST_LABEL: baseEnv.KOBE_CAPTURE_HOST_LABEL ?? "puretui-replay",
    KOBE_CAPTURE_SESSION_LABEL: baseEnv.KOBE_CAPTURE_SESSION_LABEL ?? basename(demoRoot),
  }
}

export function encodeKey(key) {
  const named = {
    Enter: "\r",
    Escape: "\u001b",
    Tab: "\t",
    Backspace: "\u007f",
    Up: "\u001b[A",
    Down: "\u001b[B",
    Right: "\u001b[C",
    Left: "\u001b[D",
    Home: "\u001b[H",
    End: "\u001b[F",
    PageUp: "\u001b[5~",
    PageDown: "\u001b[6~",
    Delete: "\u001b[3~",
  }
  if (named[key]) return named[key]
  const control = /^C-([a-z@\[\\\]\^_])$/i.exec(key)
  if (control) return String.fromCharCode(control[1].toUpperCase().charCodeAt(0) & 0x1f)
  if ([...key].length === 1) return key
  throw new Error(`unsupported replay key "${key}"`)
}

const defaultRunReset = (file, args, options) =>
  new Promise((resolveReset, reject) => {
    const child = spawnChild(file, args, { ...options, stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_192)
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) resolveReset()
      else reject(new Error(`sandbox reset failed (${signal ?? code ?? "unknown"}): ${stderr.trim()}`))
    })
  })

const assertRequest = (request) => {
  if (!request || typeof request !== "object") throw new Error("sidecar request must be an object")
  if (!Number.isInteger(request.id)) throw new Error("sidecar request id must be an integer")
  if (typeof request.op !== "string") throw new Error("sidecar request op must be a string")
  return request
}

export function createSidecarController(dependencies) {
  const {
    spawnPty,
    createTerminal,
    runReset = defaultRunReset,
    baseEnv = process.env,
    stopTimeoutMs = 5_000,
    killTimeoutMs = 2_000,
  } = dependencies
  let child
  let terminal
  let childAlive = false
  let childExited = Promise.resolve()
  let resolveChildExit = () => {}
  let demoRoot = ""
  let childEnv
  let kobeDir = ""
  let rows = 0
  let rawAnsi = ""
  let writes = Promise.resolve()

  const snapshotLines = async () => {
    await writes
    if (!terminal) return Array.from({ length: rows }, () => "")
    return Array.from({ length: rows }, (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? "")
  }

  const diagnostics = async (message) => ({
    message,
    snapshot: rawAnsi || (await snapshotLines()).join("\n"),
    pid: child?.pid,
    demoRoot,
  })

  const waitForExit = async (timeoutMs) => {
    if (!childAlive) return true
    await Promise.race([childExited, delay(timeoutMs)])
    return !childAlive
  }

  const start = async (request) => {
    if (childAlive) throw new Error("PureTUI capture child is already running")
    if (typeof request.repoRoot !== "string" || typeof request.demoRoot !== "string") {
      throw new Error("start requires repoRoot and demoRoot")
    }
    if (!Number.isInteger(request.cols) || request.cols <= 0 || !Number.isInteger(request.rows) || request.rows <= 0) {
      throw new Error("start requires positive integer cols and rows")
    }
    demoRoot = resolve(request.demoRoot)
    rows = request.rows
    kobeDir = join(resolve(request.repoRoot), "packages", "kobe")
    childEnv = isolatedEnvironment(baseEnv, demoRoot)
    terminal = createTerminal({ cols: request.cols, rows: request.rows })
    child = spawnPty("bun", ["run", "dev:sandbox"], {
      name: "xterm-256color",
      cols: request.cols,
      rows: request.rows,
      cwd: kobeDir,
      env: childEnv,
    })
    childAlive = true
    childExited = new Promise((resolveExit) => (resolveChildExit = resolveExit))
    child.onExit(() => {
      childAlive = false
      resolveChildExit()
    })
    child.onData((data) => {
      rawAnsi = `${rawAnsi}${data}`.slice(-1_048_576)
      writes = writes.then(
        () => new Promise((resolveWrite) => terminal.write(data, resolveWrite)),
      )
    })
    return { pid: child.pid, demoRoot, snapshot: "" }
  }

  const stop = async () => {
    if (!child) return { pid: undefined, demoRoot, snapshot: "" }
    if (childAlive) {
      child.write("\u0003")
      if (!(await waitForExit(stopTimeoutMs))) {
        child.kill()
        await waitForExit(killTimeoutMs)
      }
    }
    await runReset("bun", ["run", "dev:sandbox:reset"], { cwd: kobeDir, env: childEnv })
    if (childAlive) throw new Error("PureTUI child remained alive after interrupt, kill, and sandbox reset")
    const value = { pid: child.pid, demoRoot, snapshot: (await snapshotLines()).join("\n") || rawAnsi }
    terminal?.dispose()
    return value
  }

  const execute = async (request) => {
    if (request.op === "start") return start(request)
    if (request.op === "stop") return stop()
    if (!child) throw new Error(`${request.op} requires a started PureTUI child`)
    if (request.op === "type") {
      if (typeof request.text !== "string") throw new Error("type requires text")
      child.write(request.text)
      return null
    }
    if (request.op === "key") {
      child.write(encodeKey(request.key))
      return null
    }
    if (request.op === "snapshot") return snapshotLines()
    if (request.op === "waitFor") {
      if (typeof request.pattern !== "string" || !Number.isFinite(request.timeoutMs) || request.timeoutMs < 0) {
        throw new Error("waitFor requires pattern and non-negative timeoutMs")
      }
      const deadline = Date.now() + request.timeoutMs
      for (;;) {
        const snapshot = (await snapshotLines()).join("\n")
        if (snapshot.includes(request.pattern)) return null
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${JSON.stringify(request.pattern)}`)
        await delay(25)
      }
    }
    throw new Error(`unsupported sidecar operation "${request.op}"`)
  }

  return {
    async handle(rawRequest) {
      let request
      try {
        request = assertRequest(rawRequest)
        return { id: request.id, ok: true, value: await execute(request) }
      } catch (error) {
        return {
          id: request?.id ?? rawRequest?.id ?? -1,
          ok: false,
          error: await diagnostics(error instanceof Error ? error.message : String(error)),
        }
      }
    },
  }
}

async function main() {
  const [{ spawn }, { Terminal }] = await Promise.all([import("node-pty"), import("@xterm/headless")])
  const controller = createSidecarController({
    spawnPty: spawn,
    createTerminal: (options) => new Terminal({ ...options, allowProposedApi: true, scrollback: 0 }),
  })
  const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
  input.on("line", (line) => {
    void (async () => {
      let request
      try {
        request = JSON.parse(line)
      } catch (error) {
        process.stdout.write(
          `${JSON.stringify({ id: -1, ok: false, error: { message: `invalid request JSON: ${error.message}`, snapshot: "", demoRoot: "" } })}\n`,
        )
        return
      }
      process.stdout.write(`${JSON.stringify(await controller.handle(request))}\n`)
    })()
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
