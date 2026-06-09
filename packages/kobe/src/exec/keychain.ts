/**
 * OS keychain for remote-project SSH passwords.
 *
 * A remote project's password is NEVER persisted in `state.json` — only a
 * `keychainRef` (service + account) is. The secret itself lives in the OS
 * keychain and is read on demand, just-in-time, to bring up the SSH
 * ControlMaster (see `exec-host.ts`). This module is the only place that
 * touches the keychain.
 *
 * macOS-primary: it shells out to the built-in `security` CLI. Linux
 * (`secret-tool`) / Windows (`cmdkey`/DPAPI) are not wired yet — `isSupported`
 * reports false there so callers can degrade with a clear message instead of
 * silently failing. The subprocess runner is injected (`KeychainDeps`) so
 * tests never touch the real keychain.
 *
 * Security:
 *   - The password is passed to `security add-generic-password` via `-w`
 *     followed by the value as a SEPARATE argv element. That does momentarily
 *     expose it on this process's own argv during the store; storing is a
 *     rare, user-initiated `kobe add --remote` action, not a hot path, and
 *     there is no env-based alternative for `security`. Reads (`-w` with no
 *     value) print the secret to stdout and never put it on argv.
 *   - Never logged; callers must not echo the returned value.
 */

import { spawnSync } from "node:child_process"
import { platform } from "node:os"

/** Where a secret lives in the keychain — this is what `state.json` stores. */
export interface KeychainRef {
  readonly service: string
  readonly account: string
}

/** Injected subprocess + platform seam so tests don't touch the real keychain. */
export interface KeychainDeps {
  /** Run a command; returns stdout + exit code. */
  run(argv: readonly string[]): { stdout: string; exitCode: number }
  /** `process.platform` value (`"darwin"`, `"linux"`, `"win32"`). */
  platform(): string
}

const defaultDeps: KeychainDeps = {
  run(argv) {
    const [cmd, ...rest] = argv
    const proc = spawnSync(cmd ?? "", rest, { encoding: "utf8", shell: false })
    return { stdout: proc.stdout ?? "", exitCode: proc.status ?? -1 }
  },
  platform() {
    return platform()
  },
}

/** The keychain service name kobe stores remote passwords under. */
export const KOBE_KEYCHAIN_SERVICE = "kobe-remote-ssh"

/** Build the canonical ref for a remote project (`user@host:port`). */
export function remoteKeychainRef(host: string, user: string, port?: number): KeychainRef {
  return { service: KOBE_KEYCHAIN_SERVICE, account: port ? `${user}@${host}:${port}` : `${user}@${host}` }
}

/** Whether keychain storage is available on this platform (macOS only today). */
export function isKeychainSupported(deps: KeychainDeps = defaultDeps): boolean {
  return deps.platform() === "darwin"
}

/**
 * Store (or overwrite) a password. Returns true on success. `-U` updates an
 * existing item instead of erroring on a duplicate.
 */
export function setKeychainPassword(ref: KeychainRef, password: string, deps: KeychainDeps = defaultDeps): boolean {
  if (deps.platform() !== "darwin") return false
  const { exitCode } = deps.run([
    "security",
    "add-generic-password",
    "-U",
    "-s",
    ref.service,
    "-a",
    ref.account,
    "-w",
    password,
  ])
  return exitCode === 0
}

/** Read a password back, or null if absent / unsupported. */
export function getKeychainPassword(ref: KeychainRef, deps: KeychainDeps = defaultDeps): string | null {
  if (deps.platform() !== "darwin") return null
  const { stdout, exitCode } = deps.run([
    "security",
    "find-generic-password",
    "-s",
    ref.service,
    "-a",
    ref.account,
    "-w",
  ])
  if (exitCode !== 0) return null
  // `security -w` appends a trailing newline; the password itself never has one.
  return stdout.replace(/\n$/, "")
}

/** Delete a stored password. Returns true if an item was removed. */
export function deleteKeychainPassword(ref: KeychainRef, deps: KeychainDeps = defaultDeps): boolean {
  if (deps.platform() !== "darwin") return false
  const { exitCode } = deps.run(["security", "delete-generic-password", "-s", ref.service, "-a", ref.account])
  return exitCode === 0
}
