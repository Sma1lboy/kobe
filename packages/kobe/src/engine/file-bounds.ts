import { readFileSync, statSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"

export const MAX_ENGINE_FILE_BYTES = 100 * 1024 * 1024

export const MAX_JSONL_LINE_CHARS = 8 * 1024 * 1024

export async function readTextFileBounded(p: string, maxBytes = MAX_ENGINE_FILE_BYTES): Promise<string> {
  const { size } = await stat(p)
  if (size > maxBytes) return ""
  return readFile(p, "utf8")
}

export function readTextFileSyncBounded(p: string, maxBytes = MAX_ENGINE_FILE_BYTES): string | null {
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(p)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
  if (st.size > maxBytes) return null
  return readFileSync(p, "utf8")
}

export function isJsonlLineWithinBound(line: string, maxChars = MAX_JSONL_LINE_CHARS): boolean {
  return line.length <= maxChars
}
