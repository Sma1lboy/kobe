import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import type { EngineCommandEntry } from "@/types/engine"
import { extractFrontmatterField, resolveHome, safeReaddir, scanSkillRoot } from "../command-discovery"
import { BUILTIN_CLAUDE_SLASHES } from "./builtin-slashes"

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function scanCommandsDir(dir: string): Promise<readonly EngineCommandEntry[]> {
  const entries = await safeReaddir(dir)
  const out: EngineCommandEntry[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue
    const full = join(dir, entry)
    if (!(await isFile(full))) continue
    let description = ""
    try {
      description = extractFrontmatterField(await readFile(full, "utf-8"), "description") ?? ""
    } catch {
      description = ""
    }
    out.push({
      display: `/${entry.slice(0, -3)}`,
      description: description || undefined,
      source: "user",
      kind: "slash",
    })
  }
  return out
}

async function scanClaudeRoot(root: string, source: "user" | "project"): Promise<readonly EngineCommandEntry[]> {
  const [skills, commands] = await Promise.all([
    scanSkillRoot(join(root, "skills")),
    scanCommandsDir(join(root, "commands")),
  ])
  const map = new Map<string, EngineCommandEntry>()
  for (const skill of skills) {
    map.set(skill.name, {
      display: `/${skill.name}`,
      description: skill.description || undefined,
      source,
      kind: "skill",
    })
  }
  for (const command of commands) {
    map.set(command.display.slice(1), { ...command, source })
  }
  return [...map.values()]
}

export async function listClaudeCommands(cwd?: string): Promise<readonly EngineCommandEntry[]> {
  const map = new Map<string, EngineCommandEntry>()
  for (const entry of BUILTIN_CLAUDE_SLASHES) {
    map.set(entry.name, {
      display: `/${entry.name}`,
      description: entry.description || undefined,
      aliases: entry.aliases?.map((a) => `/${a}`),
      source: "builtin",
      kind: "slash",
    })
  }
  for (const entry of await scanClaudeRoot(join(resolveHome(), ".claude"), "user")) {
    map.set(entry.display.slice(1), entry)
  }
  if (cwd) {
    for (const entry of await scanClaudeRoot(join(cwd, ".claude"), "project")) {
      map.set(entry.display.slice(1), entry)
    }
  }
  return [...map.values()].sort((a, b) => a.display.localeCompare(b.display))
}
