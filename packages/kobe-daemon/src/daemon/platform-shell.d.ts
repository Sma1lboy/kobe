export interface ResolveLoginShellOptions {
  /** Shell to use on POSIX when `$SHELL` is unset. Defaults to `/bin/bash`. */
  readonly fallback?: string
  readonly platform?: NodeJS.Platform
  readonly env?: Readonly<Record<string, string | undefined>>
}

export declare function resolveLoginShell(options?: ResolveLoginShellOptions): string

export declare function toPosixPath(filePath: string, platform?: NodeJS.Platform): string
