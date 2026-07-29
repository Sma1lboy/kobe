# @sma1lboy/kobe-plugin-sdk

Typed SDK for writing [kobe](https://github.com/Sma1lboy/kobe) plugins.

**Optional by design.** The plugin contract stays plain env + CLI + unix
socket — any language, no SDK required. This package is TypeScript sugar
over that same contract for authors who want autocomplete and types:
event-name unions, envelope types, a daemon socket client, CLI helpers,
and a tiny pane kit for terminal "pages". Zero dependencies, runs under
Node ≥ 18 and Bun.

The event/channel catalogs here are the **single source**: kobe's daemon
imports them from this package's `./contract` module (a source-only,
in-repo subpath — external consumers import the package root), so the
host and the SDK agree by construction. The SDK versions independently
via changesets; every kobe release publishes any not-yet-released SDK
version to npm.

```bash
npm install @sma1lboy/kobe-plugin-sdk
```

## Event hook

```ts
// notify.ts — [[events]] on = "agent.turn-complete"
import { pluginContext, pluginEvent, notify } from "@sma1lboy/kobe-plugin-sdk"

const ctx = pluginContext()          // typed KOBE_PLUGIN_* env
const ev = pluginEvent()             // typed KOBE_PLUGIN_EVENT_JSON envelope
if (ev?.task) await notify(`${ev.task.title} finished a turn`)
```

## Settings

```ts
import { pluginContext, setting } from "@sma1lboy/kobe-plugin-sdk"
const mode = setting(pluginContext().configDir, "MODE", "fast")
```

## A pane ("page")

```ts
// board.ts — [[panes]] command = ["node", "$KOBE_PLUGIN_ROOT/board.js"]
import { Pane, KobeSocket } from "@sma1lboy/kobe-plugin-sdk"

const pane = new Pane()
const daemon = new KobeSocket()
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

## Calling back into kobe

```ts
import { kobe, kobeJson, dispatch, listTasks, openPane } from "@sma1lboy/kobe-plugin-sdk"

await dispatch(taskId, "run the tests")            // text into a live session
const tasks = await listTasks()                    // kobe api list (JSON)
await openPane("you.example.board")                // open your own pane
await kobe(["api", "issue-create", "--repo", ".", "--title", "found a bug"])
```

Full contract (manifest reference, event catalog, env table):
[docs/PLUGIN-AUTHORING.md](https://github.com/Sma1lboy/kobe/blob/main/docs/PLUGIN-AUTHORING.md).
