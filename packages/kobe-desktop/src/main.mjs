import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { app, BrowserWindow, ipcMain, Menu, shell } from "electron"
import { findPorts } from "./ports.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, "..")
const repoRoot = resolve(packageDir, "../..")
const webDir = resolve(repoRoot, "packages/kobe-web")
const preloadPath = resolve(here, "preload.cjs")
const iconPath = resolve(packageDir, "assets/icon.png")

let webProcess = null
let mainWindow = null
let stopping = false

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
  const daemonWebPort = Number.parseInt(process.env.KOBE_DAEMON_WEB_PORT ?? "5174", 10)
  const ports = await findPorts(
    Number.parseInt(process.env.KOBE_DESKTOP_PORT ?? "5173", 10),
    daemonWebPort,
  )
  const env = {
    ...process.env,
    KOBE_WEB_PORT: String(ports.web),
    KOBE_DAEMON_WEB_PORT: String(ports.daemonWeb),
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
  // `localhost`, not 127.0.0.1: vite dev binds the hostname, which on modern
  // macOS resolves to ::1 — an IPv4 probe would sit refused until timeout.
  const base = `http://localhost:${ports.web}/`
  await waitForUrl(base)
  // The desktop shell opens straight into the GUI chat surface (/chat) —
  // override with KOBE_DESKTOP_ROUTE for another entry page.
  const route = process.env.KOBE_DESKTOP_ROUTE ?? "chat"
  return `${base}${route.replace(/^\//, "")}?kobeDesktop=1`
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "kobe",
    icon: iconPath,
    frame: false,
    hasShadow: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: preloadPath,
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

function windowFromEvent(event) {
  return BrowserWindow.fromWebContents(event.sender)
}

ipcMain.on("kobe-window:minimize", (event) => {
  windowFromEvent(event)?.minimize()
})

ipcMain.on("kobe-window:close", (event) => {
  windowFromEvent(event)?.close()
})

ipcMain.on("kobe-window:toggle-maximize", (event) => {
  const window = windowFromEvent(event)
  if (!window) return
  if (window.isMaximized()) window.unmaximize()
  else window.maximize()
})

app.on("window-all-closed", () => {
  stopWebProcess()
  app.quit()
})

app.on("before-quit", () => {
  stopWebProcess()
})

async function bootstrap() {
  console.log("kobe desktop: starting")
// The renderer owns cmd+W (close TAB) and friends, so the app menu must
// not shadow them: default roles minus the Close Window accelerator.
function installMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      {
        label: "Window",
        submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }],
      },
    ]),
  )
}

  await app.whenReady()
  installMenu()
  if (process.platform === "darwin") app.dock?.setIcon(iconPath)
  const url = await startKobeWeb()
  console.log(`kobe desktop: loading ${url}`)
  createWindow(url)
}

void bootstrap().catch((err) => {
  console.error(`kobe desktop: ${err instanceof Error ? err.message : String(err)}`)
  stopWebProcess()
  app.quit()
})
