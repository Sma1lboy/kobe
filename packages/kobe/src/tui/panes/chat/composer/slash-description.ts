const SLASH_DESCRIPTION_MAX_CHARS = 72

export function formatSlashDescription(description: string | undefined): string | undefined {
  const oneLine = description?.replace(/\s+/g, " ").trim()
  if (!oneLine) return undefined
  if (oneLine.length <= SLASH_DESCRIPTION_MAX_CHARS) return oneLine
  return `${oneLine.slice(0, SLASH_DESCRIPTION_MAX_CHARS - 3).trimEnd()}...`
}
