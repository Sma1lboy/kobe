import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import {
  migrateRoveClientStateLayout,
  migrateRoveDaemonStateLayout,
  migrateRoveStateLayout,
} from "../../src/state/layout-migration.ts"

let root: string | undefined

function write(relative: string, text: string): void {
  const path = join(root!, relative)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text, "utf8")
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

describe("migrateRoveStateLayout", () => {
  test("copies product data without moving legacy files or copying compatibility-only roots", () => {
    root = mkdtempSync(join(tmpdir(), "rove-layout-"))
    write(".kobe/tasks.json", "legacy tasks")
    write(".kobe/settings/keybindings.yaml", "ctrl+x: task.close")
    write(".kobe/issues.json", "legacy issues")
    write(".kobe/worktrees/repo/task/file", "worktree")
    write(".kobe/plugins/demo/state/value", "plugin")
    write(".kobe/daemon.pid", "123")
    write(".config/kobe/state.json", "legacy prefs")

    const result = migrateRoveStateLayout({ ROVE_HOME_DIR: root })

    expect(result).toMatchObject({ attempted: true, warnings: [] })
    expect(readFileSync(join(root, ".rove/tasks.json"), "utf8")).toBe("legacy tasks")
    expect(readFileSync(join(root, ".rove/settings/keybindings.yaml"), "utf8")).toContain("task.close")
    expect(readFileSync(join(root, ".rove/issues.json"), "utf8")).toBe("legacy issues")
    expect(readFileSync(join(root, ".config/rove/state.json"), "utf8")).toBe("legacy prefs")
    expect(existsSync(join(root, ".rove/worktrees"))).toBe(false)
    expect(existsSync(join(root, ".rove/plugins"))).toBe(false)
    expect(existsSync(join(root, ".rove/daemon.pid"))).toBe(false)
    expect(readFileSync(join(root, ".kobe/tasks.json"), "utf8")).toBe("legacy tasks")
  })

  test("never overwrites canonical files and does not repeat a completed migration", () => {
    root = mkdtempSync(join(tmpdir(), "rove-layout-"))
    write(".kobe/tasks.json", "legacy")
    write(".kobe/settings/keybindings.yaml", "legacy keys")
    write(".rove/tasks.json", "canonical")

    expect(migrateRoveStateLayout({ KOBE_HOME_DIR: root }).attempted).toBe(true)
    expect(readFileSync(join(root, ".rove/tasks.json"), "utf8")).toBe("canonical")
    expect(readFileSync(join(root, ".rove/settings/keybindings.yaml"), "utf8")).toBe("legacy keys")

    write(".kobe/issues.json", "added too late")
    expect(migrateRoveStateLayout({ ROVE_HOME_DIR: root })).toEqual({ attempted: false, copied: 0, warnings: [] })
    expect(existsSync(join(root, ".rove/issues.json"))).toBe(false)
  })

  test("does nothing on a fresh home without legacy data", () => {
    root = mkdtempSync(join(tmpdir(), "rove-layout-"))
    expect(migrateRoveStateLayout({ ROVE_HOME_DIR: root })).toEqual({ attempted: false, copied: 0, warnings: [] })
    expect(existsSync(join(root, ".rove"))).toBe(false)
  })

  test("defers daemon-owned files until daemon startup so the latest legacy write wins", () => {
    root = mkdtempSync(join(tmpdir(), "rove-layout-"))
    write(".kobe/tasks.json", "before old daemon write")
    write(".kobe/settings/keybindings.yaml", "legacy keys")

    expect(migrateRoveClientStateLayout({ ROVE_HOME_DIR: root }).warnings).toEqual([])
    expect(readFileSync(join(root, ".rove/settings/keybindings.yaml"), "utf8")).toBe("legacy keys")
    expect(existsSync(join(root, ".rove/tasks.json"))).toBe(false)

    write(".kobe/tasks.json", "latest old daemon write")
    expect(migrateRoveDaemonStateLayout({ ROVE_HOME_DIR: root }).warnings).toEqual([])
    expect(readFileSync(join(root, ".rove/tasks.json"), "utf8")).toBe("latest old daemon write")
  })

  test("copies symlinks as links without following their targets", () => {
    root = mkdtempSync(join(tmpdir(), "rove-layout-"))
    write(".kobe/themes/base.json", '{"name":"base"}')
    symlinkSync("base.json", join(root, ".kobe/themes/current.json"))

    const result = migrateRoveClientStateLayout({ ROVE_HOME_DIR: root })

    const migrated = join(root, ".rove/themes/current.json")
    expect(result.warnings).toEqual([])
    expect(lstatSync(migrated).isSymbolicLink()).toBe(true)
    expect(readlinkSync(migrated)).toBe("base.json")
  })

  test.skipIf(process.platform === "win32")("leaves the marker absent after a partial failure and retries", () => {
    root = mkdtempSync(join(tmpdir(), "rove-layout-"))
    write(".kobe/settings/keybindings.yaml", "ctrl+x: task.close")
    const blockedDir = join(root, ".rove/settings")
    mkdirSync(blockedDir, { recursive: true })
    chmodSync(blockedDir, 0o000)

    try {
      const failed = migrateRoveClientStateLayout({ ROVE_HOME_DIR: root })
      expect(failed.attempted).toBe(true)
      expect(failed.warnings).not.toEqual([])
      expect(existsSync(join(root, ".rove/.layout-client-migration-v1"))).toBe(false)
    } finally {
      chmodSync(blockedDir, 0o700)
    }

    const retried = migrateRoveClientStateLayout({ ROVE_HOME_DIR: root })
    expect(retried.warnings).toEqual([])
    expect(readFileSync(join(blockedDir, "keybindings.yaml"), "utf8")).toContain("task.close")
    expect(existsSync(join(root, ".rove/.layout-client-migration-v1"))).toBe(true)
  })
})
