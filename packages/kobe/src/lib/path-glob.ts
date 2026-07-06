import { basename } from "node:path"

export function globToRegExp(glob: string): RegExp {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const segmentStart = i === 0 || glob[i - 1] === "/"
        if (segmentStart && glob[i + 2] === "/") {
          re += "(?:.*/)?"
          i += 2
        } else {
          re += ".*"
          i++
        }
      } else {
        re += "[^/]*"
      }
    } else if (c === "?") {
      re += "[^/]"
    } else if (c && "\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`
    } else {
      re += c
    }
  }
  return new RegExp(`^${re}$`)
}

export function matchPathGlob(glob: string, p: string): boolean {
  let re: RegExp
  try {
    re = globToRegExp(glob)
  } catch {
    return false
  }
  return re.test(p) || re.test(basename(p))
}
