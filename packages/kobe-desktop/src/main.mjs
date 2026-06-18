import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { app, BrowserWindow, shell } from "electron"

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, "..")
const repoRoot = resolve(packageDir, "../..")
const webDir = resolve(repoRoot, "packages/kobe-web")

let webProcess = null
let mainWindow = null
let stopping = false

function canListen(port) {
  return new Promise((resolveListen) => {
    const server = createServer()
    server.once("error", () => resolveListen(false))
    server.once("listening", () => {
      server.close(() => resolveListen(true))
    })
    server.listen(port, "127.0.0.1")
  })
}

async function findPortBlock(start = 5173) {
  for (let port = start; port < start + 200; port += 1) {
    if (
      (await canListen(port)) &&
      (await canListen(port + 1)) &&
      (await canListen(port + 2))
    ) {
      return {
        web: port,
        bridge: port + 1,
        pty: port + 2,
      }
    }
  }
  throw new Error(`no free 3-port block found starting at ${start}`)
}

function stopWebProcess() {
  if (stopping) return
  stopping = true
  if (webProcess && webProcess.exitCode === null && !webProcess.killed) {
    webProcess.kill("SIGTERM")
    setTimeout(() => {
      if (webProcess && webProcess.exitCode === null && !webProcess.killed) {
        webProcess.kill("SIGKILL")
      }
    }, 2000).unref()
  }
}

async function waitForUrl(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(800) })
      if (res.ok) return
      lastError = new Error(`HTTP ${res.status}`)
    } catch (err) {
      lastError = err
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(
    `timed out waiting for ${url}${lastError ? ` (${lastError.message})` : ""}`,
  )
}

async function startKobeWeb() {
  const ports = await findPortBlock(
    Number.parseInt(process.env.KOBE_DESKTOP_PORT ?? "5173", 10),
  )
  const env = {
    ...process.env,
    KOBE_WEB_PORT: String(ports.web),
    KOBE_BRIDGE_PORT: String(ports.bridge),
    KOBE_PTY_PORT: String(ports.pty),
  }
  webProcess = spawn("bun", ["run", "dev.ts"], {
    cwd: webDir,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  })
  webProcess.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(`kobe desktop: web process exited (${code ?? signal})`)
      app.quit()
    }
  })
  const url = `http://127.0.0.1:${ports.web}/`
  await waitForUrl(url)
  return url
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "kobe",
    backgroundColor: "#0b0d10",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target)
    return { action: "deny" }
  })

  void mainWindow.loadURL(url)
  mainWindow.once("closed", () => {
    mainWindow = null
  })
}

app.on("window-all-closed", () => {
  stopWebProcess()
  app.quit()
})

app.on("before-quit", () => {
  stopWebProcess()
})

async function bootstrap() {
  console.log("kobe desktop: starting")
  await app.whenReady()
  const url = await startKobeWeb()
  console.log(`kobe desktop: loading ${url}`)
  createWindow(url)
}

void bootstrap().catch((err) => {
  console.error(`kobe desktop: ${err instanceof Error ? err.message : String(err)}`)
  stopWebProcess()
  app.quit()
})
