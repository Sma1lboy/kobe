import { BoxRenderable, TextRenderable, createCliRenderer } from "@opentui/core"
const renderer = await createCliRenderer({ exitOnCtrlC: true })
const box = new BoxRenderable(renderer, { id: "b", flexGrow: 1 })
renderer.root.add(box)
const t = new TextRenderable(renderer, { id: "t", content: "x" })
box.add(t)
const out: string[] = []
let i = 0
const timer = setInterval(() => {
  i++
  t.content = `tick ${i} ${"a".repeat(40)}`
  if (i % 1000 === 0) {
    const m = process.memoryUsage()
    out.push(`${i} rss=${Math.round(m.rss / 1048576)}MB heap=${Math.round(m.heapUsed / 1048576)}MB`)
    Bun.write("/tmp/leakprobe.txt", `${out.join("\n")}\n`)
  }
  if (i >= 12000) {
    clearInterval(timer)
    process.exit(0)
  }
}, 4)
