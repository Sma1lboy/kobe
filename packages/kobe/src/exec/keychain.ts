import { spawnSync } from "node:child_process"
import { platform } from "node:os"

export interface KeychainRef {
  readonly service: string
  readonly account: string
}

export interface KeychainDeps {
  run(argv: readonly string[]): { stdout: string; exitCode: number }
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

export const KOBE_KEYCHAIN_SERVICE = "kobe-remote-ssh"

export function remoteKeychainRef(host: string, user: string, port?: number): KeychainRef {
  return { service: KOBE_KEYCHAIN_SERVICE, account: port ? `${user}@${host}:${port}` : `${user}@${host}` }
}

export function isKeychainSupported(deps: KeychainDeps = defaultDeps): boolean {
  return deps.platform() === "darwin"
}

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
  return stdout.replace(/\n$/, "")
}

export function deleteKeychainPassword(ref: KeychainRef, deps: KeychainDeps = defaultDeps): boolean {
  if (deps.platform() !== "darwin") return false
  const { exitCode } = deps.run(["security", "delete-generic-password", "-s", ref.service, "-a", ref.account])
  return exitCode === 0
}
