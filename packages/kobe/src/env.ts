import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

export function isDev(): boolean {
  return process.env.KOBE_DEV === "1"
}

export function nativeChatEnabled(): boolean {
  return process.env.KOBE_TUI === "1"
}

export function homeDir(): string {
  return process.env.KOBE_HOME_DIR ?? homedir()
}

export function kobeStateDir(): string {
  return join(homeDir(), ".kobe")
}

export function kvStatePath(): string {
  return join(homeDir(), ".config", "kobe", "state.json")
}

export function kobeSettingsDir(): string {
  return join(kobeStateDir(), "settings")
}

export function keybindingsConfigPath(): string {
  return join(kobeSettingsDir(), "keybindings.yaml")
}

export function issueAssetsDir(): string {
  return join(kobeStateDir(), "issue-assets")
}

export function promptAttachmentsDir(): string {
  return join(kobeStateDir(), "attachments")
}

export function remoteControlSocketPath(host: string, user: string, port?: number): string {
  const hash = createHash("sha1")
    .update(`${user}@${host}:${port ?? 22}`)
    .digest("hex")
    .slice(0, 16)
  return join(kobeStateDir(), "ssh", `${hash}.sock`)
}

export function worktreeInitMarkerPath(worktreePath: string): string {
  const hash = createHash("sha1").update(worktreePath).digest("hex").slice(0, 16)
  return join(kobeStateDir(), "worktree-init", hash)
}
