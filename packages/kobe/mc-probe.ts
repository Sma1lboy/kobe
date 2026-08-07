// React 19's scheduler drives its work loop with MessageChannel. Isolate it.
const { port1, port2 } = new MessageChannel()
let i = 0
port1.onmessage = () => {
  i++
  if (i >= 200000) {
    port1.close()
    port2.close()
    process.exit(0)
  }
}
const out: string[] = []
const timer = setInterval(() => {
  for (let k = 0; k < 250; k++) port2.postMessage(null)
  const m = process.memoryUsage()
  out.push(`${i} rss=${Math.round(m.rss / 1048576)}MB heap=${Math.round(m.heapUsed / 1048576)}MB`)
  Bun.write("/tmp/mc.txt", `${out.slice(-20).join("\n")}\n`)
}, 1000)
timer
