/**
 * Read a PNG image off the OS clipboard and write it to a caller-
 * supplied destination path. Returns the mime type on success; `null`
 * when the clipboard doesn't contain an image, the platform isn't
 * supported, or the read failed.
 *
 * Why we shell out to `osascript` on macOS rather than linking a
 * native binding (claude-code uses `image-processor-napi`): kobe is
 * pure-TS and ships no platform-specific binaries today. A 80–150 ms
 * AppleScript round-trip is fine for a manual paste gesture — the
 * cost is paid once per Ctrl+V, not on every keystroke.
 *
 * Linux and Windows are intentional stubs. The plan tracks them as
 * follow-ups; for now the caller surfaces a clear "not yet supported
 * on $platform" toast when {@link clipboardImageSupported} is false.
 */
import { spawn } from "node:child_process"
import { statSync } from "node:fs"

/** True iff the current platform has a clipboard-image reader. */
export function clipboardImageSupported(): boolean {
  return process.platform === "darwin"
}

export interface ClipboardImageResult {
  readonly mimeType: string
}

/**
 * Read a PNG off the clipboard into `destPath`. Caller is responsible
 * for picking `destPath` (and for ensuring the parent directory
 * exists — we don't `mkdir` here, that's the writer's job per the
 * pattern set by `env.kobeStateDir()`).
 *
 * Returns `null` on any failure path so the caller has a single
 * "no image" branch to handle. The script never throws — AppleScript
 * `try`-wraps the read, and a non-zero `osascript` exit (e.g. clipboard
 * holds text rather than an image) yields `null` cleanly.
 */
export async function readClipboardImageToFile(destPath: string): Promise<ClipboardImageResult | null> {
  if (process.platform === "darwin") {
    return readClipboardImageMacOS(destPath)
  }
  return null
}

async function readClipboardImageMacOS(destPath: string): Promise<ClipboardImageResult | null> {
  // AppleScript read of the clipboard's PNG representation, written
  // straight to `destPath`. The `try`/`error number 1` arms ensure the
  // process exits non-zero when the clipboard isn't an image so we can
  // cheaply detect "nothing to paste" without parsing stderr.
  const script = [
    "try",
    `  set fpath to POSIX file ${quoteAppleScript(destPath)}`,
    "  set png_data to (the clipboard as «class PNGf»)",
    "  set f to open for access fpath with write permission",
    "  set eof of f to 0",
    "  write png_data to f",
    "  close access f",
    "on error",
    "  error number 1",
    "end try",
  ].join("\n")
  // Async spawn — this runs inside the render process, and the repo-wide
  // guard (test/tui/render-path-sync-guard.test.ts) bans synchronous
  // subprocesses in src/tui/**: a 100ms+ sync osascript would freeze the
  // whole frame loop, not just the paste gesture.
  const status = await new Promise<number | null>((resolve) => {
    const proc = spawn("osascript", ["-e", script], {
      timeout: 5000,
      stdio: ["ignore", "ignore", "ignore"],
    })
    proc.once("error", () => resolve(null))
    proc.once("close", (code) => resolve(code))
  })
  if (status !== 0) return null
  // Belt-and-suspenders: confirm the file landed and is non-empty.
  // AppleScript can return `ok` even on weird clipboard states where
  // the PNG payload is zero bytes; treat that as a miss.
  try {
    const st = statSync(destPath)
    if (st.size === 0) return null
  } catch {
    return null
  }
  return { mimeType: "image/png" }
}

/**
 * Quote a string for embedding inside AppleScript. We round-trip via
 * `JSON.stringify` because AppleScript's string literal syntax is the
 * same as JSON's for the characters we care about (`"`, `\`, `\n`),
 * which is good enough for filesystem paths under
 * `~/.kobe/pasted-images/<uuid>.png`. Anything weirder and the read
 * just fails — no security boundary here, the path is one we minted.
 */
function quoteAppleScript(value: string): string {
  return JSON.stringify(value)
}
