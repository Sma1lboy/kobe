export interface OriginPolicyOptions {
  readonly allowedHost?: string | undefined
}

export function isLoopbackHost(hostname: string | null | undefined): boolean
export function originHostname(origin: string): string | null
export function isLoopbackOrigin(origin: string): boolean
export function originAllowed(origin: string | null | undefined, opts?: OriginPolicyOptions): boolean
export function allowedHostForBindHost(hostname: string | null | undefined): string | undefined
