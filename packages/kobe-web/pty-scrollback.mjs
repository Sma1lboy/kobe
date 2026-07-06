
export function createScrollback(cap) {
  let chunks = []
  let total = 0

  return {
    push(data) {
      if (!data) return
      chunks.push(data)
      total += data.length
      while (total > cap && chunks.length > 1) {
        const dropped = chunks.shift()
        total -= dropped.length
      }
    },
    replay() {
      if (chunks.length === 0) return ""
      return chunks.length === 1 ? chunks[0] : chunks.join("")
    },
    length() {
      return total
    },
    chunkCount() {
      return chunks.length
    },
  }
}
