import { spawn as spawnChild } from "node:child_process"
import { chmod } from "node:fs/promises"
import { createRequire } from "node:module"
import { createInterface } from "node:readline"
import { pathToFileURL } from "node:url"
import { basename, dirname, join, resolve } from "node:path"

const require = createRequire(import.meta.url)

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
    KOBE_DEV: "1",
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

const defaultRunCommand = (file, args, options, description) =>
  new Promise((resolveReset, reject) => {
    const child = spawnChild(file, args, { ...options, stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_192)
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) resolveReset()
      else reject(new Error(`${description} failed (${signal ?? code ?? "unknown"}): ${stderr.trim()}`))
    })
  })

const defaultRunSetup = (file, args, options) => defaultRunCommand(file, args, options, "capture setup")
const defaultRunReset = (file, args, options) => defaultRunCommand(file, args, options, "sandbox reset")

const rgbComponents = (color) => [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff]

const cellStyle = (cell) => {
  const codes = [0]
  if (cell.isBold?.()) codes.push(1)
  if (cell.isDim?.()) codes.push(2)
  if (cell.isItalic?.()) codes.push(3)
  if (cell.isUnderline?.()) codes.push(4)
  if (cell.isBlink?.()) codes.push(5)
  if (cell.isInverse?.()) codes.push(7)
  if (cell.isInvisible?.()) codes.push(8)
  if (cell.isStrikethrough?.()) codes.push(9)
  if (cell.isFgRGB?.()) codes.push(38, 2, ...rgbComponents(cell.getFgColor()))
  else if (cell.isFgPalette?.()) codes.push(38, 5, cell.getFgColor())
  else if (!cell.isFgDefault?.()) codes.push(39)
  if (cell.isBgRGB?.()) codes.push(48, 2, ...rgbComponents(cell.getBgColor()))
  else if (cell.isBgPalette?.()) codes.push(48, 5, cell.getBgColor())
  else if (!cell.isBgDefault?.()) codes.push(49)
  return codes.join(";")
}

export function serializeXtermLine(line) {
  if (!line) return ""
  if (typeof line.getCell !== "function") return line.translateToString?.(true) ?? ""
  const cells = []
  let lastMeaningful = -1
  for (let index = 0; index < line.length; index++) {
    const cell = line.getCell(index)
    if (!cell || cell.getWidth?.() === 0) continue
    const chars = cell.getChars?.() || " "
    const styled = cell.isAttributeDefault?.() === false
    cells.push({ index, chars, styled, style: styled ? cellStyle(cell) : "0" })
    if (chars !== " " || styled) lastMeaningful = index
  }
  if (lastMeaningful < 0) return ""
  let result = ""
  let style = "0"
  for (const cell of cells) {
    if (cell.index > lastMeaningful) break
    if (cell.style !== style) {
      result += `\u001b[${cell.style}m`
      style = cell.style
    }
    result += cell.chars
  }
  if (style !== "0") result += "\u001b[0m"
  return result
}

export async function ensureNodePtySpawnHelperExecutable(dependencies = {}) {
  if ((dependencies.platform ?? process.platform) === "win32") return
  const resolveModule = dependencies.resolveModule ?? ((name) => require.resolve(name))
  const chmodFile = dependencies.chmodFile ?? chmod
  const packageRoot = dirname(dirname(resolveModule("node-pty")))
  const helper = join(
    packageRoot,
    "prebuilds",
    `${dependencies.platform ?? process.platform}-${dependencies.arch ?? process.arch}`,
    "spawn-helper",
  )
  await chmodFile(helper, 0o755)
}

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
    runSetup = defaultRunSetup,
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
    return Array.from({ length: rows }, (_, row) => serializeXtermLine(terminal.buffer.active.getLine(row)))
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
    if (
      typeof request.repoRoot !== "string" ||
      typeof request.demoRoot !== "string" ||
      typeof request.fixtureRepo !== "string"
    ) {
      throw new Error("start requires repoRoot, demoRoot, and fixtureRepo")
    }
    if (!Number.isInteger(request.cols) || request.cols <= 0 || !Number.isInteger(request.rows) || request.rows <= 0) {
      throw new Error("start requires positive integer cols and rows")
    }
    demoRoot = resolve(request.demoRoot)
    rows = request.rows
    const repoRoot = resolve(request.repoRoot)
    const fixtureRepo = resolve(request.fixtureRepo)
    kobeDir = join(repoRoot, "packages", "kobe")
    const cliPath = join(kobeDir, "src", "cli", "index.ts")
    childEnv = isolatedEnvironment(baseEnv, demoRoot)
    const seedTasks = request.seedTasks ?? []
    if (!Array.isArray(seedTasks)) throw new Error("start seedTasks must be an array")
    for (const task of seedTasks) {
      if (!task || typeof task.title !== "string" || typeof task.status !== "string") {
        throw new Error("start seedTasks entries require title and status")
      }
      await runSetup(
        "bun",
        [
          "--conditions=browser",
          cliPath,
          "api",
          "add",
          "--repo",
          fixtureRepo,
          "--title",
          task.title,
          "--status",
          task.status,
        ],
        { cwd: fixtureRepo, env: childEnv },
      )
    }
    terminal = createTerminal({ cols: request.cols, rows: request.rows })
    child = spawnPty("bun", ["--conditions=browser", cliPath], {
      name: "xterm-256color",
      cols: request.cols,
      rows: request.rows,
      cwd: fixtureRepo,
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
    if (!child) {
      if (childEnv && kobeDir) await runReset("bun", ["run", "dev:sandbox:reset"], { cwd: kobeDir, env: childEnv })
      return { pid: undefined, demoRoot, snapshot: "" }
    }
    if (childAlive) {
      child.write("\u0003")
      if (!(await waitForExit(stopTimeoutMs))) {
        child.kill("SIGTERM")
        await waitForExit(killTimeoutMs)
      }
      if (childAlive) {
        child.kill("SIGKILL")
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
  await ensureNodePtySpawnHelperExecutable()
  const [ptyModule, headlessModule] = await Promise.all([import("node-pty"), import("@xterm/headless")])
  const spawn = ptyModule.spawn ?? ptyModule.default?.spawn
  const Terminal = headlessModule.Terminal ?? headlessModule.default?.Terminal
  if (typeof spawn !== "function" || typeof Terminal !== "function") {
    throw new Error("PureTUI sidecar could not load node-pty or @xterm/headless")
  }
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
  input.on("close", () => process.exit(0))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
