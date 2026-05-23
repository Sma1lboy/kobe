/**
 * Ops pane main loop (v0.6.0).
 *
 * Uses Solid + @opentui/solid for parity with @sma1lboy/kobe so we
 * can reuse rendering primitives later (theme, status bar, etc) when
 * the ops menu lands in 0.6.x. Today this is just two boxes:
 *
 *   ┌─ git status ──────────────────────┐
 *   │ ## branch...origin/main           │
 *   │  M src/foo.ts                     │
 *   │ ?? notes.md                       │
 *   ├─ tree (depth 2) ──────────────────┤
 *   │ src/                              │
 *   │   foo.ts                          │
 *   │   bar.ts                          │
 *   │ README.md                         │
 *   └───────────────────────────────────┘
 *
 * Refresh: every `REFRESH_MS` (1s) plus on `r`. Tmux closes the pane
 * automatically when the process exits via `q`.
 */

import { render } from "@opentui/solid"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { type GitStatus, readGitStatus } from "../lib/git-status.ts"
import { readTree } from "../lib/tree.ts"

const REFRESH_MS = 1000

export interface RunOpsPaneOpts {
  readonly taskId: string
  readonly worktree: string
  readonly targetPane?: string
}

export async function runOpsPane(opts: RunOpsPaneOpts): Promise<void> {
  await render(() => <OpsPane {...opts} />, {
    backgroundColor: "transparent",
    externalOutputMode: "passthrough",
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
  })
}

function OpsPane(props: RunOpsPaneOpts): unknown {
  const [status, setStatus] = createSignal<GitStatus>({ branchLine: "", entries: [] })
  const [tree, setTree] = createSignal<readonly string[]>([])
  const [generation, setGeneration] = createSignal(0)

  const refresh = async (): Promise<void> => {
    const [s, t] = await Promise.all([readGitStatus(props.worktree), readTree(props.worktree)])
    setStatus(s)
    setTree(t)
    setGeneration((g) => g + 1)
  }

  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    const onKey = (chunk: Buffer) => {
      const s = chunk.toString("utf8")
      if (s === "q" || s === "\x03" /* Ctrl+C */) process.exit(0)
      if (s === "r") void refresh()
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.on("data", onKey)
    }
    onCleanup(() => {
      clearInterval(timer)
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false)
        process.stdin.removeListener("data", onKey)
      }
    })
  })

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" gap={1}>
        <text fg="#cccccc">kobe-ops</text>
        <text fg="#888888">·</text>
        <text fg="#888888">{props.taskId.slice(0, 12)}</text>
      </box>
      <text fg="#888888">{props.worktree}</text>
      <box flexDirection="column" paddingTop={1}>
        <text fg="#88ccff">git</text>
        <Show when={status().branchLine.length > 0}>
          <text fg="#cccccc">{status().branchLine}</text>
        </Show>
        <For each={status().entries}>
          {(entry) => (
            <box flexDirection="row" gap={1}>
              <text fg={colorForStatusCode(entry.code)}>{entry.code}</text>
              <text fg="#cccccc">{entry.path}</text>
            </box>
          )}
        </For>
        <Show when={status().entries.length === 0 && status().branchLine.length > 0}>
          <text fg="#666666">(clean)</text>
        </Show>
      </box>
      <box flexDirection="column" paddingTop={1} flexGrow={1}>
        <text fg="#88ccff">tree</text>
        <For each={tree()}>{(line) => <text fg="#cccccc">{line}</text>}</For>
      </box>
      <box flexDirection="row" gap={2} paddingTop={1}>
        <text fg="#666666">r refresh</text>
        <text fg="#666666">q quit</text>
        <text fg="#444444">gen {generation()}</text>
      </box>
    </box>
  )
}

function colorForStatusCode(code: string): string {
  if (code.startsWith("?")) return "#ffaa55" // untracked
  if (code.includes("M")) return "#ffcc66" // modified
  if (code.includes("A")) return "#88ddaa" // added
  if (code.includes("D")) return "#ff6666" // deleted
  if (code.includes("R")) return "#aa88ff" // renamed
  return "#cccccc"
}
