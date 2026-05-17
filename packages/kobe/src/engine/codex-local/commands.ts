import { join } from "node:path"
import type { EngineCommandEntry } from "@/types/engine"
import { findUpwardSkillRoots, resolveCodexHome, resolveHome, safeReaddir, scanSkillRoot } from "../command-discovery"

type CodexSkillRoot = {
  readonly path: string
  readonly source: EngineCommandEntry["source"]
  readonly pluginPrefix?: string
}

async function scanPluginSkillRoots(codexHome: string): Promise<readonly CodexSkillRoot[]> {
  const cacheRoot = join(codexHome, "plugins", "cache")
  const marketplaces = await safeReaddir(cacheRoot)
  const out: CodexSkillRoot[] = []
  for (const marketplace of marketplaces) {
    const marketplaceRoot = join(cacheRoot, marketplace)
    for (const plugin of await safeReaddir(marketplaceRoot)) {
      out.push({ path: join(marketplaceRoot, plugin, "local", "skills"), source: "user", pluginPrefix: plugin })
    }
  }
  return out
}

export async function listCodexCommands(cwd?: string): Promise<readonly EngineCommandEntry[]> {
  const codexHome = resolveCodexHome()
  const roots: CodexSkillRoot[] = [
    { path: join(codexHome, "skills"), source: "user" },
    { path: join(resolveHome(), ".agents", "skills"), source: "user" },
    { path: join(codexHome, "skills", ".system"), source: "system" },
  ]
  if (cwd) {
    for (const root of await findUpwardSkillRoots(cwd, join(".codex", "skills"))) {
      roots.push({ path: root, source: "project" })
    }
    for (const root of await findUpwardSkillRoots(cwd, join(".agents", "skills"))) {
      roots.push({ path: root, source: "project" })
    }
  }
  roots.push(...(await scanPluginSkillRoots(codexHome)))

  const map = new Map<string, EngineCommandEntry>()
  for (const root of roots) {
    for (const skill of await scanSkillRoot(root.path)) {
      const name = root.pluginPrefix && !skill.name.includes(":") ? `${root.pluginPrefix}:${skill.name}` : skill.name
      map.set(name, {
        display: `/${name}`,
        description: skill.description || undefined,
        source: root.source,
        kind: "skill",
        submitText: `$${name}`,
      })
    }
  }
  return [...map.values()].sort((a, b) => a.display.localeCompare(b.display))
}
