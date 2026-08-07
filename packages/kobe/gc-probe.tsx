import { gcAndSweep } from "bun:jsc"
/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { useEffect, useState } from "react"
const GC = process.env.PROBE_GC === "1"
Bun.write("/tmp/gcprobe.pid", String(process.pid))
function App() {
  const [n, setN] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), 4)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (GC && n > 0 && n % 5000 === 0) gcAndSweep()
    if (n >= 120000) process.exit(0)
  }, [n])
  return (
    <box flexGrow={1}>
      <text content={`row ${n} ${"x".repeat(60)}`} />
    </box>
  )
}
const renderer = await createCliRenderer({ exitOnCtrlC: true })
createRoot(renderer).render(<App />)
