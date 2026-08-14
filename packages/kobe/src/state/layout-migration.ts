/** Safe, additive migration from the legacy kobe data layout to Rove. */

import { randomUUID } from "node:crypto"
import type { Stats } from "node:fs"
import {
  constants,
  closeSync,
  copyFileSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { readRoveEnv } from "@sma1lboy/kobe-daemon/compat-env"
import {
  LEGACY_KOBE_CONFIG_DIR_BASENAME,
  LEGACY_KOBE_STATE_DIR_BASENAME,
  ROVE_CONFIG_DIR_BASENAME,
  ROVE_STATE_DIR_BASENAME,
} from "../product.ts"

const CLIENT_MIGRATION_MARKER = ".layout-client-migration-v1"
const DAEMON_MIGRATION_MARKER = ".layout-daemon-migration-v1"

/** Client-owned data can move while a pre-upgrade daemon is still alive. */
const CLIENT_STATE_ENTRIES = ["attachments", "settings", "themes"] as const

/** Single-writer data must be copied only while the new daemon starts. */
const DAEMON_STATE_ENTRIES = [
  "attention-inbox.json",
  "automations.json",
  "issue-assets",
  "issues.json",
  "notes",
  "notes.json",
  "tasks.json",
  "worktree-init",
] as const

export interface StateLayoutMigrationResult {
  readonly attempted: boolean
  readonly copied: number
  readonly warnings: readonly string[]
}

function lstatIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw err
  }
}

function removeTemp(path: string): void {
  try {
    unlinkSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
}

function syncFile(path: string): void {
  const handle = openSync(path, "r")
  try {
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
}

function publishTemp(temp: string, destination: string): boolean {
  try {
    linkSync(temp, destination)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false
    throw err
  }
}

/** Publish a complete regular file atomically, without replacing a winner. */
function copyRegularFile(source: string, destination: string): number {
  const temp = `${destination}.migration-${process.pid}-${randomUUID()}.tmp`
  try {
    copyFileSync(source, temp, constants.COPYFILE_EXCL)
    syncFile(temp)
    return publishTemp(temp, destination) ? 1 : 0
  } finally {
    removeTemp(temp)
  }
}

/** Write the completion marker with the same crash-safe publication rule. */
function writeMarker(destination: string): void {
  const temp = `${destination}.migration-${process.pid}-${randomUUID()}.tmp`
  try {
    writeFileSync(temp, "legacy kobe state copied without overwrite\n", { flag: "wx" })
    syncFile(temp)
    publishTemp(temp, destination)
  } finally {
    removeTemp(temp)
  }
}

/** Copy one tree without following symlinks or replacing any destination node. */
function copyMissing(source: string, destination: string): number {
  const sourceStat = lstatIfExists(source)
  if (!sourceStat) return 0
  const destinationStat = lstatIfExists(destination)
  if (destinationStat) {
    if (!sourceStat.isDirectory() || !destinationStat.isDirectory()) return 0
    let copied = 0
    for (const name of readdirSync(source)) copied += copyMissing(join(source, name), join(destination, name))
    return copied
  }
  mkdirSync(dirname(destination), { recursive: true })
  if (sourceStat.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: sourceStat.mode })
    let copied = 0
    for (const name of readdirSync(source)) copied += copyMissing(join(source, name), join(destination, name))
    return copied
  }
  if (sourceStat.isSymbolicLink()) {
    try {
      symlinkSync(readlinkSync(source), destination)
      return 1
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return 0
      throw err
    }
  }
  return copyRegularFile(source, destination)
}

/**
 * Copy legacy product data into the canonical layout exactly once.
 *
 * The migration is deliberately non-destructive: sources remain in place,
 * existing Rove files always win, and worktrees/plugins/runtime files are not
 * copied. A failed item leaves the marker absent so the next launch retries.
 */
function migrateStateEntries(
  entries: readonly string[],
  markerName: string,
  includeConfig: boolean,
  env: NodeJS.ProcessEnv,
): StateLayoutMigrationResult {
  const home = readRoveEnv("HOME_DIR", env) ?? homedir()
  const legacyState = join(home, LEGACY_KOBE_STATE_DIR_BASENAME)
  const roveState = join(home, ROVE_STATE_DIR_BASENAME)
  const legacyConfig = join(home, ".config", LEGACY_KOBE_CONFIG_DIR_BASENAME, "state.json")
  const roveConfig = join(home, ".config", ROVE_CONFIG_DIR_BASENAME, "state.json")
  const marker = join(roveState, markerName)
  let hasSource: boolean
  try {
    if (lstatIfExists(marker)) return { attempted: false, copied: 0, warnings: [] }
    hasSource = Boolean(lstatIfExists(legacyState) || (includeConfig && lstatIfExists(legacyConfig)))
  } catch (err) {
    return {
      attempted: true,
      copied: 0,
      warnings: [`migration preflight: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
  if (!hasSource) return { attempted: false, copied: 0, warnings: [] }

  let copied = 0
  const warnings: string[] = []
  for (const name of entries) {
    try {
      copied += copyMissing(join(legacyState, name), join(roveState, name))
    } catch (err) {
      warnings.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (includeConfig) {
    try {
      copied += copyMissing(legacyConfig, roveConfig)
    } catch (err) {
      warnings.push(`state.json: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (warnings.length === 0) {
    mkdirSync(roveState, { recursive: true })
    try {
      writeMarker(marker)
    } catch (err) {
      warnings.push(`migration marker: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { attempted: true, copied, warnings }
}

/** Copy UI/client-owned state before any command reads its canonical path. */
export function migrateRoveClientStateLayout(env: NodeJS.ProcessEnv = process.env): StateLayoutMigrationResult {
  return migrateStateEntries(CLIENT_STATE_ENTRIES, CLIENT_MIGRATION_MARKER, true, env)
}

/** Copy daemon-owned state immediately before a new daemon opens its stores. */
export function migrateRoveDaemonStateLayout(env: NodeJS.ProcessEnv = process.env): StateLayoutMigrationResult {
  return migrateStateEntries(DAEMON_STATE_ENTRIES, DAEMON_MIGRATION_MARKER, false, env)
}

/** Aggregate helper for tests and one-shot migration tools. */
export function migrateRoveStateLayout(env: NodeJS.ProcessEnv = process.env): StateLayoutMigrationResult {
  const client = migrateRoveClientStateLayout(env)
  const daemon = migrateRoveDaemonStateLayout(env)
  return {
    attempted: client.attempted || daemon.attempted,
    copied: client.copied + daemon.copied,
    warnings: [...client.warnings, ...daemon.warnings],
  }
}
