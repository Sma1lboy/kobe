import * as fs from "node:fs"
import * as os from "node:os"

export function expandHome(p: string): string {
  if (p === "~") return os.homedir()
  if (p.startsWith("~/")) return os.homedir() + p.slice(1)
  return p
}

export type PathSplit = { base: string; filter: string }

export function splitPathForDirSuggest(value: string): PathSplit {
  if (!value) return { base: "", filter: "" }
  const normalized = value === "~" ? "~/" : value
  const expanded = expandHome(normalized)
  if (expanded.endsWith("/")) return { base: expanded, filter: "" }
  const lastSlash = expanded.lastIndexOf("/")
  if (lastSlash === -1) return { base: "", filter: expanded }
  return { base: expanded.slice(0, lastSlash + 1), filter: expanded.slice(lastSlash + 1) }
}

export function listSubdirs(base: string): readonly string[] {
  if (!base) return []
  try {
    const entries = fs.readdirSync(base, { withFileTypes: true })
    const out: string[] = []
    for (const e of entries) {
      if (e.isDirectory()) out.push(e.name)
    }
    return out.sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

export function filterSubdirs(all: readonly string[], filter: string): readonly string[] {
  const f = filter.toLowerCase()
  const showHidden = f.startsWith(".")
  const visible = showHidden ? all : all.filter((n) => !n.startsWith("."))
  if (!f) return visible
  return visible.filter((n) => n.toLowerCase().startsWith(f))
}

export function joinDrill(typedValue: string, baseExpanded: string, name: string): string {
  const out = `${baseExpanded + name}/`
  if (typedValue.startsWith("~")) {
    const home = os.homedir()
    if (out === `${home}/`) return "~/"
    if (out.startsWith(`${home}/`)) return `~${out.slice(home.length)}`
  }
  return out
}

export function joinPicked(typedValue: string, baseExpanded: string, name: string): string {
  const out = baseExpanded + name
  if (typedValue.startsWith("~")) {
    const home = os.homedir()
    if (out === home) return "~"
    if (out.startsWith(`${home}/`)) return `~${out.slice(home.length)}`
  }
  return out
}
