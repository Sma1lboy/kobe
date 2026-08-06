// Same 4ms setInterval + closure churn, zero React, zero opentui.
const out: string[] = []
let i = 0
let state = 0
const listeners: Array<() => void> = []
const timer = setInterval(() => {
  i++
  state = state + 1
  const fn = () => state + i
  listeners[0] = fn
  fn()
  if (i % 2000 === 0) {
    const m = process.memoryUsage()
    out.push(`${i} rss=${Math.round(m.rss / 1048576)}MB heap=${Math.round(m.heapUsed / 1048576)}MB`)
    Bun.write("/tmp/leak-plain.txt", `${out.join("\n")}\n`)
  }
  if (i >= 24000) {
    clearInterval(timer)
    process.exit(0)
  }
}, 4)
