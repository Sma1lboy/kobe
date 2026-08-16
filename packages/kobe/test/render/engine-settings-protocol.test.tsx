/** @jsxImportSource @opentui/react */
/**
 * Settings → Engines writes a custom engine's PROTOCOL (issue #30).
 *
 * A custom engine is a named preset, and `engineProtocol.<id>` is the field
 * that makes every later `--command <id>` dispatch deterministic instead of
 * sniffed. Three rules are pinned here because getting any of them wrong is
 * silent:
 *
 *   - the prompt ORDER (id → command → protocol → name), since the flow
 *     assigns answers positionally;
 *   - a blank or bogus protocol writes NOTHING rather than a junk key, so the
 *     preset degrades to the generic protocol instead of claiming an adapter
 *     that would point the history reader at another vendor's files;
 *   - removing a preset clears its protocol, so re-adding the same id later
 *     cannot inherit a stale declaration.
 *
 * `useEngineSettings` is a real hook, so it runs inside a mounted component
 * here; the dialog prompts are scripted and the kv is the real provider,
 * read back through `kv.get` — the disk write behind it is debounced, and
 * what this suite is about is which keys the flow commits, not when they
 * land.
 */

import { describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { useEffect, useRef } from "react"
import { RenameTaskDialog } from "../../src/tui-react/component/rename-task-dialog"
import { useEngineSettings } from "../../src/tui-react/component/settings-dialog/use-engine-settings"
import { type KVContext, useKV } from "../../src/tui-react/context/kv"
import { useDialog } from "../../src/tui-react/ui/dialog"
import { renderComponent, settle } from "./harness"

const NOOP = (): void => {}

/**
 * Answer each `RenameTaskDialog.show` with the next scripted string (or
 * `undefined` to cancel), recording each prompt's field label so a changed
 * prompt ORDER can't silently reassign answers to the wrong fields.
 */
function scriptDialog(answers: readonly (string | undefined)[]) {
  const asked: string[] = []
  let i = 0
  const original = RenameTaskDialog.show
  RenameTaskDialog.show = (async (_dialog: unknown, _current: string, opts?: { fieldLabel?: string }) => {
    asked.push(opts?.fieldLabel ?? "?")
    // A prompt past the end of the script means the flow grew a field this
    // suite doesn't answer. Throw rather than return undefined-as-cancel, so
    // it surfaces as a failure here instead of a silently shortened flow.
    if (i >= answers.length) throw new Error(`unscripted prompt for "${opts?.fieldLabel ?? "?"}"`)
    return answers[i++]
  }) as typeof RenameTaskDialog.show
  const restore = (): void => {
    RenameTaskDialog.show = original
  }
  return { asked, restore }
}

/** Mount the hook and run one action against it, once, on mount. */
function Driver(props: { onReady: (api: ReturnType<typeof useEngineSettings>, kv: KVContext) => void }) {
  const kv = useKV()
  const dialog = useDialog()
  const api = useEngineSettings(kv, dialog, NOOP)
  const fired = useRef(false)
  useEffect(() => {
    if (fired.current) return
    fired.current = true
    props.onReady(api, kv)
  })
  return <text>engines</text>
}

/**
 * Fresh $KOBE_HOME_DIR + a mounted hook, with `run` driven from OUTSIDE the
 * component and fully awaited before this resolves.
 *
 * Deliberately not "fire it inside the mount effect and hope": that made the
 * flow depend on effect timing, and a `run` that started after the caller's
 * `script.restore()` would reach the REAL `RenameTaskDialog.show`, which
 * awaits a dialog nobody can answer — a hang that reproduces only on a slow
 * runner. Awaiting a ready-promise makes the order deterministic.
 */
async function withEngineSettings(
  run: (api: ReturnType<typeof useEngineSettings>) => void | Promise<void>,
): Promise<(key: string) => unknown> {
  process.env.KOBE_HOME_DIR = mkdtempSync(join(tmpdir(), "kobe-engine-settings-"))
  let resolveReady: (pair: readonly [ReturnType<typeof useEngineSettings>, KVContext]) => void = () => {}
  const ready = new Promise<readonly [ReturnType<typeof useEngineSettings>, KVContext]>((resolve) => {
    resolveReady = resolve
  })
  const handle = await renderComponent(<Driver onReady={(api, kv) => resolveReady([api, kv])} />, {
    width: 60,
    height: 10,
    providers: { kv: true, dialog: true },
  })
  await handle.rerender()
  const [api, kv] = await ready
  await run(api)
  await settle()
  handle.destroy()
  return (key: string) => kv.get(key, undefined)
}

describe("Settings → Engines protocol declaration", () => {
  it("records a declared protocol alongside the command and name", async () => {
    const script = scriptDialog(["mypi", "pi-cli --interactive", "claude", "My Pi"])
    let read: (key: string) => unknown = () => undefined
    try {
      read = await withEngineSettings((api) => api.addEngineFlow())
    } finally {
      script.restore()
    }
    expect(script.asked).toEqual(["id", "command", "protocol", "name"])
    expect(read("customEngineIds")).toEqual(["mypi"])
    expect(read("engineCommand.mypi")).toBe("pi-cli --interactive")
    expect(read("engineProtocol.mypi")).toBe("claude")
    expect(read("engineName.mypi")).toBe("My Pi")
  })

  it("writes no protocol key at all when the answer is blank or bogus", async () => {
    for (const answer of ["", "frobnicate"]) {
      const script = scriptDialog(["aider", "aider --model sonnet", answer, ""])
      let read: (key: string) => unknown = () => undefined
      try {
        read = await withEngineSettings((api) => api.addEngineFlow())
      } finally {
        script.restore()
      }
      // Absent, not empty-string: the preset reads as generic, and a junk
      // value must never look like a declaration.
      expect(read("engineProtocol.aider")).toBeUndefined()
      expect(read("customEngineIds")).toEqual(["aider"])
    }
  })

  it("clears the protocol when the preset is removed, so a re-add starts clean", async () => {
    const script = scriptDialog(["mypi", "pi-cli", "claude", "My Pi"])
    let read: (key: string) => unknown = () => undefined
    try {
      read = await withEngineSettings(async (api) => {
        await api.addEngineFlow()
        api.resetEngine("mypi")
      })
    } finally {
      script.restore()
    }
    expect(read("customEngineIds")).toEqual([])
    expect(read("engineProtocol.mypi")).toBe("")
    expect(read("engineCommand.mypi")).toBe("")
  })
})
