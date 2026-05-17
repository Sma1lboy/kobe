import { readFile, readdir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type SkillDoc = {
  readonly name: string
  readonly description: string
  readonly path: string
}

export function resolveHome(): string {
  return process.env.HOME ?? homedir()
}

export function resolveCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(resolveHome(), ".codex")
}

export async function safeReaddir(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export function extractFrontmatterField(content: string, key: string): string | null {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return null
  const frontmatter = match[1]
  const lines = frontmatter.split("\n")
  const prefix = `${key}:`
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const trimmed = rawLine.trim()
    if (!trimmed.startsWith(prefix)) continue
    const after = rawLine.slice(rawLine.indexOf(prefix) + prefix.length)
    const value = after.trim()
    if (value !== "|" && value !== ">") return value

    const fold = value === ">"
    const collected: string[] = []
    let blockIndent: number | null = null
    for (let j = i + 1; j < lines.length; j++) {
      const cont = lines[j]
      if (cont.trim() === "") {
        collected.push("")
        continue
      }
      const indent = cont.length - cont.trimStart().length
      if (blockIndent === null) {
        if (indent === 0) break
        blockIndent = indent
      } else if (indent < blockIndent) {
        break
      }
      collected.push(cont.slice(blockIndent ?? indent))
    }
    while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop()
    if (collected.length === 0) return ""
    if (!fold) return collected.join("\n")
    const out: string[] = []
    let pending = ""
    for (const line of collected) {
      if (line === "") {
        if (pending !== "") out.push(pending)
        out.push("")
        pending = ""
      } else {
        pending = pending === "" ? line : `${pending} ${line}`
      }
    }
    if (pending !== "") out.push(pending)
    return out.join("\n").replace(/\n+$/, "")
  }
  return null
}

export async function readSkillDoc(skillMd: string, fallbackName: string): Promise<SkillDoc | null> {
  if (!(await isFile(skillMd))) return null
  try {
    const content = await readFile(skillMd, "utf-8")
    return {
      name: extractFrontmatterField(content, "name") || fallbackName,
      description: extractFrontmatterField(content, "description") ?? "",
      path: skillMd,
    }
  } catch {
    return null
  }
}

export async function scanSkillRoot(root: string, visited: Set<string> = new Set()): Promise<readonly SkillDoc[]> {
  const canonicalRoot = await realpath(root).catch(() => root)
  if (visited.has(canonicalRoot)) return []
  visited.add(canonicalRoot)

  const entries = await safeReaddir(root)
  const out: SkillDoc[] = []
  for (const entry of entries) {
    if (entry.startsWith(".") && entry !== ".system") continue
    const sub = join(root, entry)
    if (!(await isDir(sub))) continue
    if (entry === ".system") {
      out.push(...(await scanSkillRoot(sub, visited)))
      continue
    }
    const skill = await readSkillDoc(join(sub, "SKILL.md"), entry)
    if (skill) out.push(skill)
  }
  return out
}

export async function findUpwardSkillRoots(cwd: string, relativeRoot: string): Promise<string[]> {
  const out: string[] = []
  let cur = cwd
  while (true) {
    const candidate = join(cur, relativeRoot)
    if (await isDir(candidate)) out.push(candidate)
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return out
}
