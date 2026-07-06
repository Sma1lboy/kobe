import { stat } from "node:fs/promises"
import { logClient, logClientError } from "@sma1lboy/kobe-daemon/client/client-log"
import { connectIfRunning } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { type Accessor, createSignal } from "solid-js"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { homeDir } from "../../env.ts"
import { TaskIndexStore } from "../../orchestrator/index/store.ts"
import type { Task } from "../../types/task.ts"
import { ToastOverlay } from "../component/toast-overlay"
import { sessionAttached } from "../lib/attach-gate"
import type { HostScreen } from "../lib/host-boot"
import { TasksShell } from "./host.tsx"

const RELOAD_MS = 1500

export async function setupTasksPane(opts: { initialTaskId?: string }): Promise<HostScreen> {
  const store = new TaskIndexStore({ homeDir: homeDir() })
  await store.load()
  const [fileTasks, setFileTasks] = createSignal<readonly Task[]>(store.list())

  let orch: RemoteOrchestrator | null = null
  try {
    const client = await connectIfRunning()
    if (client) {
      const remote = new RemoteOrchestrator(client)
      await remote.init()
      orch = remote
    } else {
      logClient("tasks-boot", "no daemon running — polling tasks.json (a gui owns daemon lifecycle)")
    }
  } catch (err) {
    logClientError("tasks-boot", err)
    logClient("tasks-boot", "daemon subscribe failed — polling tasks.json")
  }

  const tasks: Accessor<readonly Task[]> = () =>
    orch && orch.connectionStateSignal()() === "online" ? orch.tasksSignal()() : fileTasks()
  const reload = async (): Promise<void> => {
    await store.load()
    setFileTasks(store.list())
  }
  let lastTasksFileFingerprint = ""
  const timer = setInterval(() => {
    if (orch && orch.connectionStateSignal()() === "online") return
    void (async () => {
      if (!(await sessionAttached())) return
      let fingerprint = "missing"
      try {
        const st = await stat(store.filePath)
        fingerprint = `${st.mtimeMs}:${st.size}`
      } catch {}
      if (fingerprint === lastTasksFileFingerprint) return
      lastTasksFileFingerprint = fingerprint
      await reload()
    })().catch(() => {})
  }, RELOAD_MS)

  return {
    root: () => (
      <>
        <TasksShell tasks={tasks} initialTaskId={opts.initialTaskId} orch={orch} reload={reload} />
        <ToastOverlay />
      </>
    ),
    onDestroy: () => {
      if (timer) clearInterval(timer)
      orch?.dispose()
    },
  }
}
