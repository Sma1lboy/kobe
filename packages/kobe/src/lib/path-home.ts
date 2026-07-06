import { join } from "node:path"
import { homeDir } from "../env.ts"

export function expandTilde(path: string): string {
  if (path === "~") return homeDir()
  if (path.startsWith("~/")) return join(homeDir(), path.slice(2))
  return path
}
