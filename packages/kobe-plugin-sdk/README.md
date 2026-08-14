# @sma1lboy/rove-plugin-sdk

Typed SDK for writing [Rove](https://github.com/Sma1lboy/kobe) plugins.

**Optional by design.** The plugin contract stays plain env + CLI + unix
socket — any language, no SDK required. This package is TypeScript sugar
over that same contract for authors who want autocomplete and types:
event-name unions, envelope types, a daemon socket client, CLI helpers,
and a tiny pane kit for terminal "pages". Zero dependencies, runs under
Node ≥ 18 and Bun.

The event/channel catalogs here are the **single source**: Rove's daemon
imports them from this package's `./contract` module (a source-only,
in-repo subpath — external consumers import the package root), so the
host and the SDK agree by construction. The SDK versions independently
via changesets; every Rove release publishes any not-yet-released SDK
version to npm.

```bash
npm install @sma1lboy/rove-plugin-sdk
```

## Event hook

```ts
// notify.ts — [[events]] on = "agent.turn-complete"
import { pluginContext, pluginEvent, notify } from "@sma1lboy/rove-plugin-sdk"

const ctx = pluginContext()          // typed ROVE_PLUGIN_* env
const ev = pluginEvent()             // typed ROVE_PLUGIN_EVENT_JSON envelope
if (ev?.task) await notify(`${ev.task.title} finished a turn`)
```

## Settings

```ts
import { pluginContext, setting } from "@sma1lboy/rove-plugin-sdk"
const mode = setting(pluginContext().configDir, "MODE", "fast")
```

## A pane ("page")

```ts
// board.ts — [[panes]] command = ["node", "$ROVE_PLUGIN_ROOT/board.js"]
import { Pane, RoveSocket } from "@sma1lboy/rove-plugin-sdk"

const pane = new Pane()
const daemon = new RoveSocket()
await daemon.connect()

let tasks: any[] = []
function frame() {
  pane.draw([
    "MY BOARD",
    "",
    ...tasks.map((t) => `  ${t.status.padEnd(8)} ${t.title}`),
  ])
}

await daemon.subscribe((name, payload) => {
  if (name === "task.snapshot") { tasks = (payload as any).tasks; frame() }
}, ["task.snapshot"])

pane.start()
pane.onKey((k) => { if (k.name === "q") pane.exit(0) })
pane.onResize(frame)
frame()
```

`Pane.draw` paints full frames with absolute cursor addressing (no newline
flow — that's what ghost-wraps in embedded terminals). Keep each row within
`pane.cols`; CJK width is the author's concern.

## Calling back into Rove

```ts
import { rove, roveJson, dispatch, listTasks, openPane } from "@sma1lboy/rove-plugin-sdk"

await dispatch(taskId, "run the tests")            // text into a live session
const tasks = await listTasks()                    // Rove API task list (JSON)
await openPane("you.example.board")                // open your own pane
await rove(["api", "issue-create", "--repo", ".", "--title", "found a bug"])
```

Full contract (manifest reference, event catalog, env table):
[docs/PLUGIN-AUTHORING.md](https://github.com/Sma1lboy/kobe/blob/main/docs/PLUGIN-AUTHORING.md).

Existing plugins can keep importing `@sma1lboy/kobe-plugin-sdk`: every SDK
release publishes the same files and version under both package names. The
legacy `kobe()` / `kobeJson()` helpers, `KobeSocket` class, and `KOBE_*`
environment aliases remain available as well.
