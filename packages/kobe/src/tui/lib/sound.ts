/**
 * One-shot notification sound. Ported from opencode's
 * `packages/opencode/src/cli/cmd/tui/util/sound.ts` (MIT) and trimmed to
 * a single `pulse()` entry point — kobe only needs a short ding when a
 * background chat tab transitions out of `running`.
 *
 * Strategy:
 *   1. Probe the user's PATH for the first available audio player
 *      (afplay on macOS, ffplay/mpv/play/aplay/etc. elsewhere) and cache
 *      the choice.
 *   2. Copy the bundled `pulse.wav` to `$TMPDIR/kobe-sfx/` on first use
 *      so the asset has a stable filesystem path even when kobe runs
 *      from the bundled `dist/` (Bun's `with { type: "file" }` import
 *      already gives us a real path, but caching in tmp also keeps
 *      repeated spawns cheap and isolates the asset from `dist`
 *      reinstalls).
 *   3. Spawn the player detached with all stdio ignored. Failures are
 *      swallowed — the BEL in `notifications.tsx` is the always-on
 *      fallback; this just adds an audible chime on top.
 *
 * If no player is on PATH (rare on a Mac dev box, common in stripped CI
 * containers), `pulse()` is a no-op and we rely on the terminal bell.
 */

import { existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import pulseAssetRaw from "../asset/pulse.wav" with { type: "file" }

// Bun's `with { type: "file" }` import returns an absolute path in dev
// and a path relative to the emitting chunk in `bun build` output.
// Normalise against `import.meta.dir` so both modes resolve to a real
// file on disk.
const pulseAsset = isAbsolute(pulseAssetRaw) ? pulseAssetRaw : resolve(import.meta.dir, pulseAssetRaw)

const DIR = join(tmpdir(), "kobe-sfx")

const PLAYERS = [
  "ffplay",
  "mpv",
  "mpg123",
  "mpg321",
  "mplayer",
  "afplay",
  "play",
  "omxplayer",
  "aplay",
  "cmdmp3",
  "cvlc",
  "powershell.exe",
] as const

type Player = (typeof PLAYERS)[number]

/**
 * Per-player argv. Volume is 0..1; players that take percent get
 * `round(volume * 100)`, ffmpeg-style filter-graphs use the raw float.
 */
function args(player: Player, file: string, volume: number): string[] {
  if (player === "ffplay") return [player, "-autoexit", "-nodisp", "-af", `volume=${volume}`, file]
  if (player === "mpv")
    return [player, "--no-video", "--audio-display=no", "--volume", String(Math.round(volume * 100)), file]
  if (player === "mpg123" || player === "mpg321") return [player, "-g", String(Math.round(volume * 100)), file]
  if (player === "mplayer") return [player, "-vo", "null", "-volume", String(Math.round(volume * 100)), file]
  if (player === "afplay" || player === "omxplayer" || player === "aplay" || player === "cmdmp3") return [player, file]
  if (player === "play") return [player, "-v", String(volume), file]
  if (player === "cvlc") return [player, `--gain=${volume}`, "--play-and-exit", file]
  return [player, "-c", `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`]
}

let cachedPlayer: Player | null | undefined
let cachedPath: Promise<string> | undefined

function pickPlayer(): Player | null {
  if (cachedPlayer !== undefined) return cachedPlayer
  const path = process.env.PATH ?? ""
  const segments = path.split(":").filter(Boolean)
  cachedPlayer = PLAYERS.find((p) => segments.some((dir) => existsSync(join(dir, p)))) ?? null
  return cachedPlayer
}

async function ensureAsset(): Promise<string> {
  cachedPath ??= (async () => {
    mkdirSync(DIR, { recursive: true })
    const dest = join(DIR, basename(pulseAsset))
    const out = Bun.file(dest)
    if (await out.exists()) return dest
    await Bun.write(out, Bun.file(pulseAsset))
    return dest
  })()
  return cachedPath
}

/**
 * Fire one short ding. Best-effort, never throws.
 */
export function pulse(volume = 0.4): void {
  const player = pickPlayer()
  if (!player) return
  void ensureAsset()
    .then((path) => {
      try {
        const proc = Bun.spawn(args(player, path, volume), {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        })
        // Detach so the player's lifetime doesn't keep kobe alive at
        // shutdown. Bun's `unref()` is on the underlying Subprocess.
        proc.unref?.()
      } catch {
        /* swallow */
      }
    })
    .catch(() => undefined)
}
