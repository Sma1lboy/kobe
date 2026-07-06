import { existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import pulseAssetRaw from "../asset/pulse.wav" with { type: "file" }

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
        proc.unref?.()
      } catch {}
    })
    .catch(() => undefined)
}
