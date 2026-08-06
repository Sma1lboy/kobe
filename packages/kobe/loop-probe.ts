// Renderer explicitly started (live loop), but NOTHING mutates the tree.
import { BoxRenderable, TextRenderable, createCliRenderer } from "@opentui/core"
const renderer = await createCliRenderer({ exitOnCtrlC: true })
const box = new BoxRenderable(renderer, { id: "b", flexGrow: 1 })
renderer.root.add(box)
box.add(new TextRenderable(renderer, { id: "t", content: "live loop, no mutation" }))
renderer.start()
Bun.write("/tmp/loopprobe.pid", String(process.pid))
