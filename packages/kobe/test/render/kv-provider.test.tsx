/**
 * KVProvider — disk-backed UI state (src/tui/context/kv.tsx). Imports
 * @opentui/solid indirectly via createSimpleContext's sibling modules? No —
 * kv.tsx itself has no @opentui import, but every real host mounts it
 * alongside Theme/Focus (lib/host-boot.tsx) and it's exercised here as the
 * other providers' shared dependency (NotificationsProvider reads
 * `useKV()`). Covers get/set/signal/dirty-key persistence against a
 * throwaway state.json, independent of any real ~/.config/kobe.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KVProvider, useKV } from "../../src/tui/context/kv"
import { renderComponent } from "./harness"

let homeDir: string
const previousHomeDir = process.env.KOBE_HOME_DIR

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "kobe-kv-render-test-"))
  process.env.KOBE_HOME_DIR = homeDir
})

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true })
  process.env.KOBE_HOME_DIR = previousHomeDir
})

function statePath(): string {
  return join(homeDir, ".config", "kobe", "state.json")
}

describe("KVProvider", () => {
  it("get() falls back to the provided default when unset", async () => {
    let seen: unknown
    function Probe() {
      const kv = useKV()
      seen = kv.get("nonexistent.key", "fallback")
      return <text>ready</text>
    }
    await renderComponent(() => (
      <KVProvider>
        <Probe />
      </KVProvider>
    ))
    expect(seen).toBe("fallback")
  })

  it("set() + flush() persists the key to state.json", async () => {
    let kvRef: ReturnType<typeof useKV> | undefined
    function Probe() {
      kvRef = useKV()
      return <text>{`v:${kvRef.get("theme.name", "default")}`}</text>
    }
    const { frame } = await renderComponent(() => (
      <KVProvider>
        <Probe />
      </KVProvider>
    ))
    kvRef?.set("theme.name", "dracula")
    kvRef?.flush()
    expect(await frame()).toContain("v:dracula")

    const onDisk = JSON.parse(readFileSync(statePath(), "utf8"))
    expect(onDisk["theme.name"]).toBe("dracula")
  })

  it("signal() hydrates a reactive accessor pair from a stored value", async () => {
    let read: (() => unknown) | undefined
    function Probe() {
      const kv = useKV()
      const [get] = kv.signal("focusAccent", "primary")
      read = get
      return <text>{`accent:${get()}`}</text>
    }
    const { frame } = await renderComponent(() => (
      <KVProvider>
        <Probe />
      </KVProvider>
    ))
    expect(await frame()).toContain("accent:primary")
    expect(read?.()).toBe("primary")
  })
})
