import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { kobeStateDir } from "@/env"

export type LayoutCoordKind = "heal" | "capture" | "resize" | "resync"

export const LAYOUT_COALESCE_MS = 120

export const RESIZE_GUARD_MS = 400

function coordDir(): string {
  return join(kobeStateDir(), "layout-coord")
}

function genPath(session: string, kind: LayoutCoordKind): string {
  const hash = createHash("sha1").update(session).digest("hex").slice(0, 16)
  return join(coordDir(), `${hash}.${kind}`)
}

export function recordGen(session: string, kind: LayoutCoordKind): string {
  const nonce = randomUUID()
  try {
    mkdirSync(coordDir(), { recursive: true })
    const path = genPath(session, kind)
    const tmp = `${path}.${nonce}.tmp`
    writeFileSync(tmp, `${Date.now()}\n${nonce}`)
    renameSync(tmp, path)
  } catch {}
  return nonce
}

export function isLatestGen(session: string, kind: LayoutCoordKind, nonce: string): boolean {
  try {
    return readFileSync(genPath(session, kind), "utf8").split("\n")[1]?.trim() === nonce
  } catch {
    return true
  }
}

export function genAgeMs(session: string, kind: LayoutCoordKind, now: number = Date.now()): number {
  try {
    const ts = Number.parseInt(readFileSync(genPath(session, kind), "utf8").split("\n")[0] ?? "", 10)
    return Number.isFinite(ts) ? now - ts : Number.POSITIVE_INFINITY
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export async function coalesceLayoutWork(
  session: string,
  kind: LayoutCoordKind,
  work: () => Promise<void>,
  debounceMs: number = LAYOUT_COALESCE_MS,
): Promise<void> {
  const nonce = recordGen(session, kind)
  if (debounceMs > 0) await new Promise((resolve) => setTimeout(resolve, debounceMs))
  if (!isLatestGen(session, kind, nonce)) return
  await work()
}
