import { homedir } from "node:os"
import { kobeCliInvocation } from "@/cli/invocation"
import { inheritedEnvPrefix } from "@/tui/panes/terminal/launch"
import {
  LAYOUT_GEOMETRY_OPTIONS,
  type LayoutGeometry,
  hiddenTerminalSessionName,
  homeWelcomeCommand,
  keepAlive,
  resolveLayoutGeometry,
  tasksPaneCommand,
} from "./session-layout"

export const KOBE_TMUX_SOCKET = process.env.KOBE_TMUX_SOCKET?.trim() || "kobe"

export function tmuxArgs(...args: string[]): string[] {
  return ["tmux", "-L", KOBE_TMUX_SOCKET, ...args]
}

export function tmuxSessionName(taskId: string): string {
  return `kobe-${taskId.replace(/[^A-Za-z0-9_-]/g, "")}`
}

export function attachArgv(name: string): string[] {
  return tmuxArgs("attach-session", "-t", `=${name}`)
}

async function drainText(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!stream) return ""
  try {
    return await new Response(stream).text()
  } catch {
    return ""
  }
}

const SAFE_SPAWN_CWD = homedir() || "/"

export async function runTmux(args: string[]): Promise<number> {
  try {
    const proc = Bun.spawn(tmuxArgs(...args), {
      stdin: "ignore",
      cwd: SAFE_SPAWN_CWD,
      stdout: "ignore",
      stderr: "pipe",
    })
    const [errText, code] = await Promise.all([drainText(proc.stderr), proc.exited])
    if (code !== 0 && errText.trim().length > 0) {
      console.error(`[kobe tmux] ${args.join(" ")} (${code}): ${errText.trim()}`)
    }
    return code
  } catch {
    return 1
  }
}

async function runTmuxQuiet(args: string[]): Promise<number> {
  try {
    const proc = Bun.spawn(tmuxArgs(...args), {
      stdin: "ignore",
      cwd: SAFE_SPAWN_CWD,
      stdout: "ignore",
      stderr: "ignore",
    })
    return await proc.exited
  } catch {
    return 1
  }
}

export function tmuxCommandSequence(commands: readonly (readonly string[])[]): string[] {
  const out: string[] = []
  for (const cmd of commands) {
    if (cmd.length === 0) continue
    if (out.length > 0) out.push(";")
    out.push(...cmd)
  }
  return out
}

export async function runTmuxSequence(commands: readonly (readonly string[])[]): Promise<number> {
  const args = tmuxCommandSequence(commands)
  return args.length === 0 ? 0 : runTmux(args)
}

export async function runTmuxCapturing(args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const proc = Bun.spawn(tmuxArgs(...args), { stdin: "ignore", cwd: SAFE_SPAWN_CWD, stdout: "pipe", stderr: "pipe" })
    const [stdout, errText, code] = await Promise.all([drainText(proc.stdout), drainText(proc.stderr), proc.exited])
    if (code !== 0 && errText.trim().length > 0) {
      console.error(`[kobe tmux] ${args.join(" ")} (${code}): ${errText.trim()}`)
    }
    return { code, stdout }
  } catch {
    return { code: 1, stdout: "" }
  }
}

export async function runTmuxSequenceCapturing(
  commands: readonly (readonly string[])[],
): Promise<{ code: number; stdout: string }> {
  const args = tmuxCommandSequence(commands)
  return args.length === 0 ? { code: 0, stdout: "" } : runTmuxCapturing(args)
}

export async function tmuxAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["tmux", "-V"], { stdin: "ignore", cwd: SAFE_SPAWN_CWD, stdout: "ignore", stderr: "ignore" })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

export async function sessionExists(name: string): Promise<boolean> {
  return (await runTmuxQuiet(["has-session", "-t", `=${name}`])) === 0
}

export async function windowCount(sessionName: string): Promise<number> {
  const { code, stdout } = await runTmuxCapturing(["list-windows", "-t", `=${sessionName}`, "-F", "#{window_id}"])
  if (code !== 0) return 0
  return stdout.split("\n").filter((l) => l.trim().length > 0).length
}

export async function setSessionOption(session: string, option: string, value: string): Promise<void> {
  await runTmux(["set-option", "-t", session, option, value])
}

export async function getSessionOption(session: string, option: string): Promise<string> {
  const { code, stdout } = await runTmuxCapturing(["show-options", "-qv", "-t", session, option])
  return code === 0 ? stdout.trim() : ""
}

export async function getSessionOptions(
  session: string,
  options: readonly string[],
): Promise<Record<string, string | undefined>> {
  const values: Record<string, string | undefined> = Object.fromEntries(options.map((option) => [option, undefined]))
  const { code, stdout } = await runTmuxSequenceCapturing(
    options.map((option) => ["show-options", "-q", "-t", session, option]),
  )
  if (code !== 0) return values
  for (const line of stdout.split("\n")) {
    const idx = line.indexOf(" ")
    if (idx <= 0) continue
    const option = line.slice(0, idx)
    if (option in values) values[option] = line.slice(idx + 1).trim()
  }
  return values
}

export async function getServerOption(option: string): Promise<string> {
  const { code, stdout } = await runTmuxCapturing(["show-options", "-sqv", option])
  return code === 0 ? stdout.trim() : ""
}

export async function getServerOptions(options: readonly string[]): Promise<Record<string, string | undefined>> {
  const values: Record<string, string | undefined> = Object.fromEntries(options.map((option) => [option, undefined]))
  const { code, stdout } = await runTmuxSequenceCapturing(options.map((option) => ["show-options", "-sq", option]))
  if (code !== 0) return values
  for (const line of stdout.split("\n")) {
    const idx = line.indexOf(" ")
    if (idx <= 0) continue
    const option = line.slice(0, idx)
    if (option in values) values[option] = line.slice(idx + 1).trim()
  }
  return values
}

export async function globalTasksPaneWidth(): Promise<number> {
  return (await readLayoutGeometry()).tasksWidth
}

export async function readLayoutGeometry(): Promise<LayoutGeometry> {
  return resolveLayoutGeometry(await getServerOptions(LAYOUT_GEOMETRY_OPTIONS))
}

export const PANE_ROLE_OPTION = "@kobe_role"
export const CLAUDE_ROLE_OPTION = PANE_ROLE_OPTION
const CLAUDE_ROLE_VALUE = "claude"

export async function tagPaneRole(paneId: string, role: string): Promise<void> {
  await runTmux(["set-option", "-p", "-t", paneId, PANE_ROLE_OPTION, role])
}

export const CHAT_TAB_SESSION_ID_OPTION = "@kobe_session_id"

export async function setWindowOption(target: string, option: string, value: string): Promise<void> {
  await runTmux(["set-window-option", "-t", target, option, value])
}

export async function tagClaudePane(paneId: string): Promise<void> {
  await tagPaneRole(paneId, CLAUDE_ROLE_VALUE)
}

export async function paneIdByRole(sessionName: string, role: string, fallbackFirst = false): Promise<string> {
  const { code, stdout } = await runTmuxCapturing([
    "list-panes",
    "-t",
    `=${sessionName}`,
    "-F",
    `#{pane_id}\t#{${PANE_ROLE_OPTION}}`,
  ])
  if (code !== 0) return ""
  let firstId = ""
  for (const line of stdout.split("\n")) {
    const [id, paneRole] = line.split("\t")
    if (!id) continue
    if (!firstId) firstId = id.trim()
    if (paneRole?.trim() === role) return id.trim()
  }
  return fallbackFirst ? firstId : ""
}

export async function claudePaneId(sessionName: string): Promise<string> {
  return paneIdByRole(sessionName, CLAUDE_ROLE_VALUE, true)
}

export async function claudePaneIdStrict(sessionName: string): Promise<string> {
  return paneIdByRole(sessionName, CLAUDE_ROLE_VALUE, false)
}

export async function capturePaneById(paneId: string, lines?: number): Promise<string> {
  if (!paneId) return ""
  const args = ["capture-pane", "-t", paneId, "-p"]
  if (typeof lines === "number" && lines > 0) args.push("-S", String(-lines))
  const { code, stdout } = await runTmuxCapturing(args)
  return code === 0 ? stdout : ""
}

export async function sendKeys(target: string, text: string): Promise<void> {
  await runTmux(["send-keys", "-t", target, "-l", "--", text])
}

export async function sendKeyName(target: string, key: string): Promise<void> {
  await runTmux(["send-keys", "-t", target, key])
}

export const SURFACE_WINDOW_OPTION = "@kobe_surface"

export async function newWindow(
  session: string,
  opts: { cwd: string; command: string; name?: string; surface?: boolean },
): Promise<void> {
  const args = ["new-window", "-t", `=${session}`, "-c", opts.cwd]
  if (opts.name) args.push("-n", opts.name)
  if (opts.surface) {
    args.push("-P", "-F", "#{window_id}")
    args.push(opts.command)
    const { code, stdout } = await runTmuxCapturing(args)
    const windowId = stdout.trim()
    if (code === 0 && windowId) await setWindowOption(windowId, SURFACE_WINDOW_OPTION, "1")
    return
  }
  args.push(opts.command)
  await runTmux(args)
}

export async function windowIsSurface(target: string): Promise<boolean> {
  const { code, stdout } = await runTmuxCapturing([
    "display-message",
    "-t",
    target,
    "-p",
    `#{${SURFACE_WINDOW_OPTION}}`,
  ])
  return code === 0 && stdout.trim() === "1"
}

export async function currentSessionName(): Promise<string | null> {
  const args = ["display-message", "-p"]
  const target = process.env.TMUX_PANE
  if (target && target.length > 0) args.push("-t", target)
  args.push("#{session_name}")
  const { code, stdout } = await runTmuxCapturing(args)
  const name = stdout.trim()
  return code === 0 && name.length > 0 ? name : null
}

async function termPaneGroups(listPanesArgs: readonly string[]): Promise<void> {
  const { code, stdout } = await runTmuxCapturing(["list-panes", ...listPanesArgs, "-F", "#{pane_pid}"])
  if (code !== 0) return
  for (const line of stdout.split("\n")) {
    const pid = Number.parseInt(line.trim(), 10)
    if (!Number.isFinite(pid) || pid <= 1) continue
    try {
      process.kill(-pid, "SIGTERM")
    } catch {}
  }
}

async function termSessionPaneGroups(name: string): Promise<void> {
  await termPaneGroups(["-s", "-t", `=${name}`])
}

export async function termAllPaneGroups(): Promise<void> {
  await termPaneGroups(["-a"])
}

export async function killSession(name: string): Promise<void> {
  if (!name.startsWith("kobe-hidden-")) {
    const hidden = hiddenTerminalSessionName(name)
    if (await sessionExists(hidden)) {
      await termSessionPaneGroups(hidden)
      await runTmux(["kill-session", "-t", `=${hidden}`])
    }
  }
  if (await sessionExists(name)) {
    await termSessionPaneGroups(name)
    await runTmux(["kill-session", "-t", `=${name}`])
  }
}

export const KOBE_HOME_SESSION = "kobe-home"

const HOME_KIND_OPTION = "@kobe_home"

export async function ensureFallbackSession(): Promise<string> {
  const name = KOBE_HOME_SESSION
  if (await sessionExists(name)) {
    if ((await getSessionOption(name, HOME_KIND_OPTION)) === "tasks") return name
    await runTmux(["kill-session", "-t", `=${name}`])
  }
  const r0 = await runTmuxCapturing([
    "new-session",
    "-d",
    "-s",
    name,
    "-c",
    SAFE_SPAWN_CWD,
    "-x",
    "220",
    "-y",
    "50",
    "-P",
    "-F",
    "#{pane_id}",
    homeWelcomeCommand(),
  ])
  const mainPane = r0.stdout.trim()
  if (mainPane) {
    const tasksWidth = await globalTasksPaneWidth()
    const r1 = await runTmuxCapturing([
      "split-window",
      "-h",
      "-b",
      "-t",
      mainPane,
      "-l",
      `${tasksWidth}`,
      "-c",
      SAFE_SPAWN_CWD,
      "-P",
      "-F",
      "#{pane_id}",
      keepAlive(inheritedEnvPrefix() + tasksPaneCommand(kobeCliInvocation())),
    ])
    const tasksPane = r1.stdout.trim()
    if (tasksPane) {
      await runTmuxSequence([
        ["set-option", "-p", "-t", tasksPane, PANE_ROLE_OPTION, "tasks"],
        ["select-pane", "-t", tasksPane],
      ])
    }
  }
  await setSessionOption(name, HOME_KIND_OPTION, "tasks")
  return name
}

export async function switchClientBeforeKill(killedName: string, nextSessionName?: string): Promise<void> {
  const current = await currentSessionName()
  if (current !== killedName) return
  const { enterWindow } = await import("../tui/panes/terminal/tmux.ts")
  if (nextSessionName && nextSessionName !== killedName && (await sessionExists(nextSessionName))) {
    await enterWindow(nextSessionName)
    return
  }
  await enterWindow(await ensureFallbackSession())
}
