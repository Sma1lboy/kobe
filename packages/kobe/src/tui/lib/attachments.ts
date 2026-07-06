import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { promptAttachmentsDir } from "../../env.ts"

const ATTACHMENT_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp|pdf)$/i
const PDF_EXTENSION_REGEX = /\.pdf$/i

function removeOuterQuotes(text: string): string {
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1)
  }
  return text
}

function stripBackslashEscapes(path: string): string {
  const salt = randomBytes(8).toString("hex")
  const placeholder = `__DOUBLE_BACKSLASH_${salt}__`
  return path.replace(/\\\\/g, placeholder).replace(/\\(.)/g, "$1").replaceAll(placeholder, "\\")
}

export function asAttachmentPath(text: string, exists: (p: string) => boolean = existsSync): string | null {
  const cleaned = stripBackslashEscapes(removeOuterQuotes(text.trim()))
  if (!ATTACHMENT_EXTENSION_REGEX.test(cleaned)) return null
  if (!isAbsolute(cleaned)) return null
  return exists(cleaned) ? cleaned : null
}

export function asAttachmentPaths(pasted: string, exists: (p: string) => boolean = existsSync): string[] | null {
  const lines = pasted
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length === 0) return null
  const paths: string[] = []
  for (const line of lines) {
    const p = asAttachmentPath(line, exists)
    if (!p) return null
    paths.push(p)
  }
  return paths
}

export function attachmentLabel(path: string, index: number): string {
  return PDF_EXTENSION_REGEX.test(path) ? `pdf[${index}]` : `images[${index}]`
}

export function appendAttachmentRefs(prompt: string, attachments: readonly string[]): string {
  if (attachments.length === 0) return prompt
  const refs = attachments.map((p, i) => `${attachmentLabel(p, i)}: ${p}`).join("\n")
  return `${prompt}\n\n${refs}`
}

async function capture(cmd: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
    const out = await new Response(proc.stdout).text()
    return (await proc.exited) === 0 ? out : null
  } catch {
    return null
  }
}

export async function captureClipboardAttachment(): Promise<string | null> {
  if (process.platform === "darwin") {
    const furl = await capture(["osascript", "-e", "get POSIX path of (the clipboard as «class furl»)"])
    const fromFile = furl ? asAttachmentPath(furl) : null
    if (fromFile) return fromFile

    const dest = newAttachmentPath()
    const saved = await capture([
      "osascript",
      "-e",
      "set png_data to (the clipboard as «class PNGf»)",
      "-e",
      `set fp to open for access POSIX file "${dest}" with write permission`,
      "-e",
      "write png_data to fp",
      "-e",
      "close access fp",
    ])
    return saved !== null && existsSync(dest) ? dest : null
  }

  if (process.platform === "linux") {
    for (const cmd of [
      ["wl-paste", "--type", "image/png"],
      ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
    ]) {
      try {
        const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
        const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer())
        if ((await proc.exited) === 0 && bytes.length > 0) {
          const dest = newAttachmentPath()
          writeFileSync(dest, bytes)
          return dest
        }
      } catch {}
    }
    return null
  }

  return null
}

function newAttachmentPath(): string {
  const dir = promptAttachmentsDir()
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "")
  return join(dir, `paste-${stamp}-${randomBytes(4).toString("hex")}.png`)
}
