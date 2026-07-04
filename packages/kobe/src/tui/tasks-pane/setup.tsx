/**
 * `kobe tasks` boot wiring — split out of `host.tsx` (which was over the
 * repo's 500-line file-size cap) into its own file. Same behavior, moved
 * verbatim: `setupTasksPane` is the exact body of the old function,
 * `startTasksPane` stays in `host.tsx` itself (mocked by that exact path
 * in `test/cli/index-pane-hosts.test.ts`) and just calls this.
 */

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
  // Task source. PRIMARY = a live daemon SUBSCRIBE (via RemoteOrchestrator):
  // a task created / renamed / deleted in ANY session's Tasks pane or in
  // the outer monitor is pushed to THIS pane in real time, so every
  // session's list stays in sync (KOB-244 — a new task wasn't showing up
  // in an already-open session's Tasks pane). The shared env baked onto
  // this pane's command (inheritedEnvPrefix) guarantees we connect to the
  // SAME daemon as everyone else.
  //
  // FALLBACK = a direct tasks.json read + slow poll, used only when the
  // daemon is unreachable. MUST pass `homeDir()` (KOBE_HOME_DIR-aware) or
  // it would read the PRODUCTION `~/.kobe/tasks.json` (KOB-233).
  const store = new TaskIndexStore({ homeDir: homeDir() })
  await store.load()
  const [fileTasks, setFileTasks] = createSignal<readonly Task[]>(store.list())

  let orch: RemoteOrchestrator | null = null
  try {
    // NON-spawning connect. A Tasks pane subscribes as role:"pane" and must
    // NEVER start a daemon — doing so would resurrect an idle-stopped daemon
    // with no gui to hold it, breaking the refcounted lazy-shutdown. This bit
    // most visibly via `kobe reload`, which respawns this pane while the user
    // may be detached (daemon already idle-stopped): a spawning connect would
    // leave a gui-less daemon running forever. A gui owns daemon lifecycle; if
    // none is up we fall through to the always-on tasks.json poll below.
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

  // Display source: prefer the daemon's live snapshot WHILE the socket is
  // online, otherwise fall back to the file poll. A plain-function accessor
  // (not createMemo) so it isn't a computation created outside a render root;
  // it reactively tracks whichever signals it reads on each call. The crucial
  // fix for the create/delete sync drift: when the daemon idle-stops / restarts
  // and the socket closes, `connectionStateSignal()` flips to "disconnected"
  // and the display switches to the always-running file poll instead of
  // FREEZING on the last daemon snapshot (the old `orch ? orch.tasksSignal()`
  // had no fallback once subscribed). The orchestrator's own non-spawning
  // reconnect loop then restores the live path when a daemon returns.
  const tasks: Accessor<readonly Task[]> = () =>
    orch && orch.connectionStateSignal()() === "online" ? orch.tasksSignal()() : fileTasks()
  const reload = async (): Promise<void> => {
    await store.load()
    setFileTasks(store.list())
  }
  // ALWAYS run the backstop poll (not gated on daemon availability, unlike
  // before — that gate was the freeze bug). It does the file read only when
  // the daemon push path is NOT the live source, so an online pane pays
  // nothing and an offline one stays fresh within RELOAD_MS.
  //
  // Offline ticks are additionally mtime-gated (waste audit): tasks.json
  // only changes on a mutation, so a cheap `stat` decides whether the full
  // read+parse is needed — an idle offline pane pays one stat per 1.5s
  // instead of re-reading and re-parsing the whole index 40×/min. Writes
  // are atomic temp+rename, so mtime+size always move on a real change.
  // A stat failure maps to a distinct "missing" fingerprint: deletion →
  // recreation each reload exactly once. Explicit `reload()` calls (after
  // mutations) bypass the gate on purpose. Errors are swallowed — this
  // pane process has no crash net (see ops/host.tsx), so a transient fs
  // error must degrade to a stale list, not an unhandled rejection.
  let lastTasksFileFingerprint = ""
  const timer = setInterval(() => {
    if (orch && orch.connectionStateSignal()() === "online") return
    void (async () => {
      // Detached (background) session: skip even the stat — nobody's looking.
      if (!(await sessionAttached())) return
      let fingerprint = "missing"
      try {
        const st = await stat(store.filePath)
        fingerprint = `${st.mtimeMs}:${st.size}`
      } catch {
        // keep the "missing" fingerprint
      }
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
    // Tear down on ACTUAL exit, not after render() resolves: `render`
    // resolves at mount (cf. startApp, which also cleans up via
    // onDestroy), so disposing here is the only correct place. Disposing
    // after `await render(...)` killed the daemon client + poll the moment
    // the pane mounted → "daemon client disposed" on the next switch and
    // a dead subscribe (KOB-247).
    onDestroy: () => {
      if (timer) clearInterval(timer)
      orch?.dispose()
    },
  }
}
