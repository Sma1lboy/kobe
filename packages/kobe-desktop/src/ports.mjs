import { createServer } from "node:net"

export function canListen(port) {
  return new Promise((resolveListen) => {
    const server = createServer()
    server.once("error", () => resolveListen(false))
    server.once("listening", () => {
      server.close(() => resolveListen(true))
    })
    server.listen(port, "127.0.0.1")
  })
}

async function firstAvailable(start, excluded, available) {
  for (let port = start; port < start + 200; port += 1) {
    if (!excluded.has(port) && (await available(port))) return port
  }
  return null
}

async function firstAvailableWebPtyPair(start, available) {
  for (let web = start; web < start + 200; web += 1) {
    const pty = web + 2
    if ((await available(web)) && (await available(pty))) return { web, pty }
  }
  return null
}

/**
 * Preserve the browser protocol's `PTY = web + 2` invariant, then reserve a
 * daemon candidate outside that pair. If the desired daemon already exists,
 * kobe-web replaces this candidate with daemon.status.webPort.
 */
export async function findPorts(start = 5173, daemonStart = 5174, available = canListen) {
  const pair = await firstAvailableWebPtyPair(start, available)
  if (pair === null) throw new Error(`no free web/PTY pair found starting at ${start}`)
  const { web, pty } = pair

  const daemonWeb = await firstAvailable(daemonStart, new Set([web, pty]), available)
  if (daemonWeb === null) throw new Error(`no free daemon web port found starting at ${daemonStart}`)

  return { web, daemonWeb, pty }
}
