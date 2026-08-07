export interface DesktopWindowControls {
  close(): void
  minimize(): void
  toggleMaximize(): void
}

declare global {
  interface Window {
    kobeDesktopWindow?: DesktopWindowControls
  }
}

export function isDesktopSearch(search: string): boolean {
  return new URLSearchParams(search).get("kobeDesktop") === "1"
}

export function enableDesktopMode(search = window.location.search): boolean {
  const enabled = isDesktopSearch(search)
  if (enabled) document.documentElement.dataset.kobeDesktop = "true"
  return enabled
}

export function isDesktopMode(): boolean {
  return document.documentElement.dataset.kobeDesktop === "true"
}

export function desktopWindowControls(): DesktopWindowControls | undefined {
  return window.kobeDesktopWindow
}

export async function preloadDesktopModules(): Promise<void> {
  await Promise.allSettled([
    import("../components/AppShell.tsx"),
    import("../components/Board.tsx"),
    import("../components/IssuesPage.tsx"),
    import("../components/WorkspaceTabs.tsx"),
    import("../components/ChatTerminal.tsx"),
    import("../components/BoardPeek.tsx"),
    import("../components/IssueIntakePanel.tsx"),
    import("../components/IssuePeek.tsx"),
    import("../components/SettingsPage.tsx"),
  ])
}
