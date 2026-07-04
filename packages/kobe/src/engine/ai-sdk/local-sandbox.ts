/**
 * Local host "sandbox" provider (harness-sandbox-v1) — runs everything for
 * real on this machine as the current user, rooted at the task's worktree.
 *
 * Lifted from mc-launcher's `packages/agent-core/src/harness/local-sandbox.ts`
 * (same author's sibling project) with one change: `workRoot` is required —
 * kobe always roots a session at a task worktree, never a tmpdir.
 *
 * Running as the user is the whole point: the harness bridge's runtime picks
 * up the locally-installed CLI's login state (Claude subscription), so no API
 * key enters the picture. There is NO isolation by design — the "sandbox" IS
 * the host, exactly like the tmux-hosted interactive CLI the pane replaces.
 */

import { spawn as nodeSpawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { Readable, Writable } from "node:stream"
import type { HarnessV1NetworkSandboxSession, HarnessV1SandboxProvider } from "@ai-sdk/harness"
import type {
  Experimental_SandboxProcess as SandboxProcess,
  Experimental_SandboxSession as SandboxSession,
} from "@ai-sdk/provider-utils"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      srv.close((err) => (err ? reject(err) : resolve(port)))
    })
    srv.on("error", reject)
  })
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: (c) => c.close() })
}

function toSandboxProcess(child: ReturnType<typeof nodeSpawn>, abortSignal?: AbortSignal): SandboxProcess {
  let killed = false
  const kill = async () => {
    if (killed) return
    killed = true
    child.kill("SIGTERM")
  }
  abortSignal?.addEventListener("abort", () => void kill(), { once: true })
  const exit = new Promise<{ exitCode: number }>((resolve) => {
    child.on("close", (code) => resolve({ exitCode: code ?? 0 }))
    child.on("error", () => resolve({ exitCode: 127 }))
  })
  return {
    pid: child.pid,
    stdout: child.stdout ? (Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>) : emptyStream(),
    stderr: child.stderr ? (Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>) : emptyStream(),
    wait: () => exit,
    kill,
  }
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  let out = ""
  const decoder = new TextDecoder()
  await stream.pipeTo(
    Writable.toWeb(
      new Writable({
        write(chunk: Uint8Array, _enc, cb) {
          out += decoder.decode(chunk, { stream: true })
          cb()
        },
      }),
    ) as WritableStream<Uint8Array>,
  )
  return out
}

export function createLocalSandbox({ workRoot }: { workRoot: string }): HarnessV1SandboxProvider {
  return {
    specificationVersion: "harness-sandbox-v1",
    providerId: "kobe-local-host-sandbox",

    createSession: async (options = {}) => {
      const id = options.sessionId ?? randomUUID()
      const root = workRoot
      await mkdir(root, { recursive: true })
      let ports: number[] = [await freePort()]
      const procs = new Set<SandboxProcess>()

      const spawnProc: SandboxSession["spawn"] = async ({ command, workingDirectory, env, abortSignal }) => {
        const child = nodeSpawn("/bin/sh", ["-c", command], {
          cwd: workingDirectory ?? root,
          env: { ...process.env, ...env },
          stdio: ["ignore", "pipe", "pipe"],
        })
        const proc = toSandboxProcess(child, abortSignal)
        procs.add(proc)
        void proc.wait().then(() => procs.delete(proc))
        return proc
      }

      const session: HarnessV1NetworkSandboxSession = {
        id,
        description: `Local host machine (${os.platform()} ${os.arch()}), working directory ${root}. Commands run as the current user with no isolation.`,
        defaultWorkingDirectory: root,
        get ports() {
          return ports
        },
        getPortUrl: async ({ port, protocol = "http" }) => `${protocol}://127.0.0.1:${port}`,
        setPorts: async (next) => {
          ports = [...next]
        },

        readFile: async ({ path: p }) => {
          const bytes = await readFile(p).catch(() => null)
          if (bytes == null) return null
          return new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new Uint8Array(bytes))
              c.close()
            },
          })
        },
        readBinaryFile: async ({ path: p }) => {
          const bytes = await readFile(p).catch(() => null)
          return bytes == null ? null : new Uint8Array(bytes)
        },
        readTextFile: async ({ path: p, encoding = "utf-8", startLine, endLine }) => {
          const bytes = await readFile(p).catch(() => null)
          if (bytes == null) return null
          const text = new TextDecoder(encoding).decode(bytes)
          if (startLine == null && endLine == null) return text
          const lines = text.split("\n")
          return lines.slice((startLine ?? 1) - 1, endLine ?? lines.length).join("\n")
        },
        writeFile: async ({ path: p, content }) => {
          await mkdir(path.dirname(p), { recursive: true })
          const chunks: Uint8Array[] = []
          for await (const chunk of content as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk)
          await writeFile(p, Buffer.concat(chunks))
        },
        writeBinaryFile: async ({ path: p, content }) => {
          await mkdir(path.dirname(p), { recursive: true })
          await writeFile(p, content)
        },
        writeTextFile: async ({ path: p, content }) => {
          await mkdir(path.dirname(p), { recursive: true })
          await writeFile(p, content, "utf-8")
        },

        spawn: spawnProc,
        run: async (opts) => {
          const proc = await spawnProc(opts)
          const [stdout, stderr, { exitCode }] = await Promise.all([
            collect(proc.stdout),
            collect(proc.stderr),
            proc.wait(),
          ])
          return { exitCode, stdout, stderr }
        },

        stop: async () => {
          await Promise.all([...procs].map((p) => p.kill()))
        },
        destroy: async () => {
          await session.stop()
        },
        restricted: () => session,
      }

      if (options.onFirstCreate) await options.onFirstCreate(session, {})
      return session
    },
  }
}
