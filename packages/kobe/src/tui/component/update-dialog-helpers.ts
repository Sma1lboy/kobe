import type { ReleaseSummary, UpdateInfo } from "../../version.ts"

export function releaseDialogTitle(info: UpdateInfo): string {
  return info.hasUpdate ? "Update available" : "Release notes"
}

export function defaultReleaseDialogVersion(info: UpdateInfo): string {
  return info.hasUpdate ? info.latest : info.current
}

export function releaseDialogVersionChoices(
  info: UpdateInfo,
  releases: readonly Pick<ReleaseSummary, "version">[],
  limit = 8,
): string[] {
  const seen = new Set<string>()
  const choices: string[] = []
  const push = (version: string | null | undefined) => {
    if (!version || seen.has(version)) return
    seen.add(version)
    choices.push(version)
  }

  push(defaultReleaseDialogVersion(info))
  push(info.current)
  for (const release of releases) push(release.version)

  return choices.slice(0, limit)
}
