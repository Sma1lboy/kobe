import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { kvStatePath } from "../env.ts"

export type StateSnapshot = Record<string, unknown>

export function loadStateFile(): StateSnapshot {
  try {
    const text = readFileSync(kvStatePath(), "utf8")
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as StateSnapshot
    }
  } catch {}
  return {}
}

function writeStateFile(state: StateSnapshot): void {
  const path = kvStatePath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8")
  renameSync(tmp, path)
}

export function updateStateFile(mutate: (state: StateSnapshot) => boolean | undefined): StateSnapshot {
  const state = loadStateFile()
  const shouldWrite = mutate(state)
  if (shouldWrite !== false) writeStateFile(state)
  return state
}

export function patchStateFile(patch: StateSnapshot): StateSnapshot {
  return updateStateFile((state) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete state[key]
      else state[key] = value
    }
    return undefined
  })
}

export function getPersistedBool(key: string, defaultValue: boolean): boolean {
  const value = loadStateFile()[key]
  return typeof value === "boolean" ? value : defaultValue
}

export function setPersistedBool(key: string, value: boolean): void {
  patchStateFile({ [key]: value })
}

export function replaceStateFile(snapshot: StateSnapshot): void {
  writeStateFile(snapshot)
}
