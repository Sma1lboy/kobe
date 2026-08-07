import { heapStats } from "bun:jsc"
/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { useEffect, useState } from "react"
const out: string[] = []
function App() {
  const [n, setN] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), 1)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (n > 0 && n % 10000 === 0) {
      const m = process.memoryUsage()
      const s = heapStats() as any
      const mb = (x: number) => Math.round(x / 1048576)
      out.push(
        `${n} rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}MB heapCap=${mb(s.heapCapacity)}MB mimalloc=${JSON.stringify(s.mimalloc).slice(0, 160)}`,
      )
      Bun.write("/tmp/leak-long.txt", `${out.join("\n")}\n`)
    }
    if (n >= 150000) process.exit(0)
  }, [n])
  return (
    <box flexGrow={1}>
      <text content={`row ${n}`} />
    </box>
  )
}
const renderer = await createCliRenderer({ exitOnCtrlC: true })
createRoot(renderer).render(<App />)
