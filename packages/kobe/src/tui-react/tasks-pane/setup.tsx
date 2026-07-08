/** @jsxImportSource @opentui/react */
/**
 * `kobe tasks` boot wiring — React port of `src/tui/tasks-pane/setup.tsx`
 * (React is the default runtime since 2026-07-07). `setupTasksPane` is the
 * async boot: load the on-disk task index, NON-spawning connect to the
 * daemon, and return the host screen. `startTasksPane` stays in `host.tsx`
 * (mocked by that exact path in `test/cli/index-pane-hosts.test.ts`) and
 * calls this.
 *
 * Solid→React deltas: the Solid version built the connection-aware `tasks`
 * accessor + the `fileTasks` signal + the poll interval imperatively in the
 * async body (Solid signals are global). React needs hooks, so that plumbing
 * moves into a `TasksPaneRoot` component owning `fileTasks` in `useState` and
 * the mtime-gated interval in `useEffect`. `RemoteOrchestrator`'s live
 * signals are Solid signals (inert in React render), so a `TasksPaneConnected`
 * child bridges them to plain values via `useAccessor` — the connection gate,
 * `worktreeChanges` freeze-fix gate, and every reactive prop survive that way,
 * and the pure UI (`TasksShell`) never touches a Solid signal. A null orch
 * (no daemon) short-circuits to the file-poll-only branch with each reactive
 * prop at its no-daemon fallback.
 */

import { stat } from "node:fs/promises"
import { logClient, logClientError } from "@sma1lboy/kobe-daemon/client/client-log"
import { connectIfRunning } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { useEffect, useState } from "react"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { homeDir } from "../../env.ts"
import { TaskIndexStore } from "../../orchestrator/index/store.ts"
import { sessionAttached } from "../../tui/lib/attach-gate"
import type { Task } from "../../types/task.ts"
import { ToastOverlay } from "../component/toast-overlay"
import type { HostScreen } from "../lib/host-boot"
import { useAccessor } from "../workspace/use-accessor"
import { TasksShell } from "./host.tsx"

const RELOAD_MS = 1500

export async function setupTasksPane(opts: { initialTaskId?: string }): Promise<HostScreen> {
  // Task source. PRIMARY = a live daemon SUBSCRIBE (via RemoteOrchestrator):
  // a task created / renamed / deleted in ANY session's Tasks pane or in the
  // outer monitor is pushed to THIS pane in real time. The shared env baked
  // onto this pane's command guarantees we connect to the SAME daemon as
  // everyone else. FALLBACK = a direct tasks.json read + slow poll, used only
  // when the daemon is unreachable. MUST pass `homeDir()` (KOBE_HOME_DIR-aware)
  // or it would read the PRODUCTION `~/.kobe/tasks.json`.
  const store = new TaskIndexStore({ homeDir: homeDir() })
  await store.load()

  let orch: RemoteOrchestrator | null = null
  try {
    // NON-spawning connect. A Tasks pane subscribes as role:"pane" and must
    // NEVER start a daemon — doing so would resurrect an idle-stopped daemon
    // with no gui to hold it, breaking the refcounted lazy-shutdown. A gui
    // owns daemon lifecycle; if none is up we fall through to the always-on
    // tasks.json poll below.
    const client = await connectIfRunning()
    if (client) {
      const remote = new RemoteOrchestrator(client)
      await remote.init() // hello + subscribe → tasksSignal() is now live
      orch = remote
    } else {
      logClient("tasks-boot", "no daemon running — polling tasks.json (a gui owns daemon lifecycle)")
    }
  } catch (err) {
    logClientError("tasks-boot", err)
    logClient("tasks-boot", "daemon subscribe failed — polling tasks.json")
  }

  return {
    root: () => (
      <>
        <TasksPaneRoot store={store} orch={orch} initialTaskId={opts.initialTaskId} />
        <ToastOverlay />
      </>
    ),
    // Tear down on ACTUAL exit (renderer destroy), not after render() resolves:
    // disposing at mount-resolve killed the daemon client the moment the pane
    // mounted → a dead subscribe on the next switch. The poll interval is owned
    // by TasksPaneRoot's effect and cleaned on its unmount (= renderer destroy).
    onDestroy: () => {
      orch?.dispose()
    },
  }
}

/**
 * Owns the file-poll fallback (`fileTasks` + the mtime-gated backstop
 * interval) and branches on daemon presence. With a daemon, the reactive
 * bridge lives in {@link TasksPaneConnected}; without one, the file poll is
 * the only source and every orch-derived prop takes its no-daemon fallback.
 */
function TasksPaneRoot(props: {
  store: TaskIndexStore
  orch: RemoteOrchestrator | null
  initialTaskId?: string
}) {
  const { store, orch } = props
  const [fileTasks, setFileTasks] = useState<readonly Task[]>(() => store.list())

  // Explicit reload (after a mutation) bypasses the mtime gate on purpose.
  const reload = async (): Promise<void> => {
    await store.load()
    setFileTasks(store.list())
  }

  // ALWAYS run the backstop poll (not gated on daemon availability — that gate
  // was the freeze bug). It does the file read only when the daemon push path
  // is NOT the live source, so an online pane pays nothing and an offline one
  // stays fresh within RELOAD_MS. Offline ticks are mtime-gated: a cheap
  // `stat` decides whether the full read+parse is needed. Detached sessions
  // skip even the stat. Errors are swallowed — this pane process has no crash
  // net, so a transient fs error must degrade to a stale list, not an
  // unhandled rejection.
  useEffect(() => {
    let lastFingerprint = ""
    const timer = setInterval(() => {
      if (orch && orch.connectionStateSignal()() === "online") return
      void (async () => {
        if (!(await sessionAttached())) return
        let fingerprint = "missing"
        try {
          const st = await stat(store.filePath)
          fingerprint = `${st.mtimeMs}:${st.size}`
        } catch {
          // keep the "missing" fingerprint
        }
        if (fingerprint === lastFingerprint) return
        lastFingerprint = fingerprint
        await store.load()
        setFileTasks(store.list())
      })().catch(() => {})
    }, RELOAD_MS)
    return () => clearInterval(timer)
  }, [store, orch])

  if (!orch) {
    return (
      <TasksShell
        tasks={fileTasks}
        orch={null}
        reload={reload}
        initialTaskId={props.initialTaskId}
        online={false}
        activeTaskId={null}
        uiPrefs={null}
        liveUpdate={null}
        engineState={undefined}
        taskJobs={undefined}
        worktreeChanges={undefined}
        daemonStale={false}
        daemonVersion={null}
      />
    )
  }
  return <TasksPaneConnected orch={orch} fileTasks={fileTasks} reload={reload} initialTaskId={props.initialTaskId} />
}

/**
 * Bridges `RemoteOrchestrator`'s Solid signals to plain React values via
 * `useAccessor` (the sanctioned bridge — see its header) and hands them to
 * `TasksShell`. Display source prefers the daemon's live snapshot WHILE the
 * socket is online, else the file poll — so a daemon idle-stop / restart
 * falls back to the always-running poll instead of FREEZING on the last
 * daemon snapshot.
 */
function TasksPaneConnected(props: {
  orch: RemoteOrchestrator
  fileTasks: readonly Task[]
  reload: () => Promise<void>
  initialTaskId?: string
}) {
  const { orch } = props
  const online = useAccessor(orch.connectionStateSignal()) === "online"
  const liveTasks = useAccessor(orch.tasksSignal())
  const activeTaskId = useAccessor(orch.activeTaskSignal())
  const uiPrefs = useAccessor(orch.uiPrefsSignal())
  const liveUpdate = useAccessor(orch.updateSignal())
  const engineState = useAccessor(orch.engineStateSignal())
  const taskJobs = useAccessor(orch.taskJobsSignal())
  const worktreeChanges = useAccessor(orch.worktreeChangesSignal())
  const daemonStale = useAccessor(orch.daemonStaleSignal())
  const daemonVersion = useAccessor(orch.daemonVersionSignal())

  return (
    <TasksShell
      tasks={online ? liveTasks : props.fileTasks}
      orch={orch}
      reload={props.reload}
      initialTaskId={props.initialTaskId}
      online={online}
      activeTaskId={activeTaskId}
      uiPrefs={uiPrefs}
      liveUpdate={liveUpdate}
      engineState={engineState}
      taskJobs={taskJobs}
      // Gate on the LIVE connection: offline → null so the Sidebar's local
      // poller takes over instead of freezing on the last pushed counts.
      worktreeChanges={online ? worktreeChanges : null}
      daemonStale={daemonStale}
      daemonVersion={daemonVersion}
    />
  )
}
