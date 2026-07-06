
export type Span = {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

const BASE16 = [
  "#141413", "#D47563", "#9ACA86", "#E8C96B", "#CC785C", "#9B87F5", "#D4967E", "#EAE7DF",
  "#3A3835", "#E08A76", "#B0DCA0", "#F2DA8C", "#D4967E", "#B3A3F8", "#E2B39F", "#FFFFFF",
]

function xterm256(n: number): string {
  if (n < 16) return BASE16[n]
  if (n < 232) {
    const c = n - 16
    const steps = [0, 95, 135, 175, 215, 255]
    const r = steps[Math.floor(c / 36)]
    const g = steps[Math.floor((c % 36) / 6)]
    const b = steps[c % 6]
    return `rgb(${r},${g},${b})`
  }
  const v = 8 + (n - 232) * 10
  return `rgb(${v},${v},${v})`
}

type State = Omit<Span, "text"> & { reverse?: boolean }

export function parseAnsiLine(line: string, prev: State = {}): { spans: Span[]; state: State } {
  const spans: Span[] = []
  let state: State = { ...prev }
  let buf = ""

  line = line.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "")

  const flush = () => {
    if (!buf) return
    const { reverse, ...rest } = state
    spans.push(reverse ? { ...rest, text: buf, fg: state.bg ?? "#141413", bg: state.fg ?? "#EAE7DF" } : { ...rest, text: buf })
    buf = ""
  }

  let i = 0
  while (i < line.length) {
    const esc = line.indexOf("\x1b[", i)
    if (esc === -1) {
      buf += line.slice(i)
      break
    }
    buf += line.slice(i, esc)
    const end = line.indexOf("m", esc)
    if (end === -1) break
    flush()
    const params = line.slice(esc + 2, end).split(";").map((p) => (p === "" ? 0 : Number(p)))
    for (let p = 0; p < params.length; p++) {
      const n = params[p]
      if (n === 0) state = {}
      else if (n === 1) state.bold = true
      else if (n === 2) state.dim = true
      else if (n === 3) state.italic = true
      else if (n === 4) state.underline = true
      else if (n === 7) state.reverse = true
      else if (n === 22) { state.bold = false; state.dim = false }
      else if (n === 23) state.italic = false
      else if (n === 24) state.underline = false
      else if (n === 27) state.reverse = false
      else if (n >= 30 && n <= 37) state.fg = BASE16[n - 30]
      else if (n === 38 || n === 48) {
        const key = n === 38 ? "fg" : "bg"
        if (params[p + 1] === 5) { state[key] = xterm256(params[p + 2]); p += 2 }
        else if (params[p + 1] === 2) { state[key] = `rgb(${params[p + 2]},${params[p + 3]},${params[p + 4]})`; p += 4 }
      } else if (n === 39) state.fg = undefined
      else if (n >= 40 && n <= 47) state.bg = BASE16[n - 40]
      else if (n === 49) state.bg = undefined
      else if (n >= 90 && n <= 97) state.fg = BASE16[n - 90 + 8]
      else if (n >= 100 && n <= 107) state.bg = BASE16[n - 100 + 8]
    }
    i = end + 1
  }
  flush()
  return { spans, state }
}
