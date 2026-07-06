import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export interface LockfileOptions {
  readonly forceTakeover?: boolean
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ESRCH") return false
    return true
  }
}

export class LockfileError extends Error {
  readonly heldByPid: number
  constructor(message: string, heldByPid: number) {
    super(message)
    this.name = "LockfileError"
    this.heldByPid = heldByPid
  }
}

export async function acquire(lockPath: string, opts: LockfileOptions = {}): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true })

  try {
    await writeFile(lockPath, String(process.pid), { flag: "wx" })
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err
    }
  }

  let holderPid = -1
  try {
    const raw = (await readFile(lockPath, "utf8")).trim()
    holderPid = Number.parseInt(raw, 10)
    if (!Number.isFinite(holderPid)) holderPid = -1
  } catch {
    return acquire(lockPath, opts)
  }

  const alive = holderPid > 0 && isProcessAlive(holderPid)
  if (alive && !opts.forceTakeover) {
    throw new LockfileError(`task index is locked by another kobe instance (pid ${holderPid})`, holderPid)
  }

  console.warn(
    `[kobe] removing stale lockfile at ${lockPath} (was held by pid ${holderPid}` +
      `${alive ? ", forced" : ", process gone"})`,
  )
  try {
    await unlink(lockPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ENOENT") throw err
  }
  try {
    await writeFile(lockPath, String(process.pid), { flag: "wx" })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      let winnerPid = -1
      try {
        winnerPid = Number.parseInt((await readFile(lockPath, "utf8")).trim(), 10)
      } catch {
        winnerPid = -1
      }
      throw new LockfileError(`task index lockfile contended during takeover (winner pid ${winnerPid})`, winnerPid)
    }
    throw err
  }
}

export async function release(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return
    throw err
  }
}
