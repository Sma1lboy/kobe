const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const TIME_LEN = 10
const RAND_LEN = 16

let lastTime = -1
let lastRand: number[] = new Array(RAND_LEN).fill(0)

function encodeTime(now: number, len: number): string {
  let out = ""
  let n = now
  for (let i = len - 1; i >= 0; i--) {
    const mod = n % 32
    out = ALPHABET[mod] + out
    n = (n - mod) / 32
  }
  return out
}

function randomIndices(len: number): number[] {
  const buf = new Uint8Array(len)
  crypto.getRandomValues(buf)
  const out: number[] = new Array(len)
  for (let i = 0; i < len; i++) {
    out[i] = (buf[i] ?? 0) & 0x1f
  }
  return out
}

function incrementIndices(indices: number[]): boolean {
  for (let i = indices.length - 1; i >= 0; i--) {
    const v = indices[i] ?? 0
    if (v < 31) {
      indices[i] = v + 1
      return true
    }
    indices[i] = 0
  }
  return false
}

function indicesToString(indices: number[]): string {
  let out = ""
  for (const idx of indices) {
    out += ALPHABET[idx] ?? "0"
  }
  return out
}

export function ulid(now: number = Date.now()): string {
  let randIndices: number[]
  if (now === lastTime) {
    const next = lastRand.slice()
    if (!incrementIndices(next)) {
      randIndices = randomIndices(RAND_LEN)
    } else {
      randIndices = next
    }
  } else {
    randIndices = randomIndices(RAND_LEN)
  }
  lastTime = now
  lastRand = randIndices
  return encodeTime(now, TIME_LEN) + indicesToString(randIndices)
}

export function _resetUlidStateForTests(): void {
  lastTime = -1
  lastRand = new Array(RAND_LEN).fill(0)
}

export const ULID_ALPHABET = ALPHABET
