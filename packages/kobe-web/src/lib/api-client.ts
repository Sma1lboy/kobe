export type QueryValue = string | number | boolean | null | undefined
export type QueryParams = Record<string, QueryValue | readonly QueryValue[]>

export interface ApiRequestOptions {
  readonly query?: QueryParams
  readonly label?: string
}

export class ApiError extends Error {
  readonly status: number
  readonly url: string
  readonly detail: string
  readonly body: unknown

  constructor(args: {
    readonly url: string
    readonly status: number
    readonly label: string
    readonly detail?: string
    readonly body?: unknown
    readonly name?: string
  }) {
    super(
      `${args.label} failed (${args.status})${args.detail ? `: ${args.detail}` : ""}`,
    )
    this.name = args.name || "ApiError"
    this.status = args.status
    this.url = args.url
    this.detail = args.detail ?? ""
    this.body = args.body
  }
}

export function apiUrl(path: string, query?: QueryParams): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(query ?? {})) {
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) {
      if (item === null || item === undefined) continue
      parts.push(
        `${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`,
      )
    }
  }
  if (parts.length === 0) return path
  return `${path}${path.includes("?") ? "&" : "?"}${parts.join("&")}`
}

async function readPayload(
  res: Response,
): Promise<{ json?: unknown; text: string }> {
  const text = await res.text().catch(() => "")
  if (!text) return { text }
  try {
    return { text, json: JSON.parse(text) }
  } catch {
    return { text }
  }
}

function errorDetail(payload: { json?: unknown; text: string }): {
  detail: string
  name?: string
} {
  const json = payload.json
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const record = json as Record<string, unknown>
    const error = typeof record.error === "string" ? record.error : ""
    const name = typeof record.name === "string" ? record.name : undefined
    if (error) return { detail: error, name }
  }
  return { detail: payload.text.trim() }
}

async function requestJson<T>(
  path: string,
  init: RequestInit,
  opts: ApiRequestOptions = {},
): Promise<T> {
  const url = apiUrl(path, opts.query)
  const res = await fetch(url, init)
  const payload = await readPayload(res)
  const json = payload.json
  const serverError =
    json &&
    typeof json === "object" &&
    !Array.isArray(json) &&
    typeof (json as Record<string, unknown>).error === "string" &&
    ((json as Record<string, unknown>).error as string).length > 0

  if (!res.ok || serverError) {
    const { detail, name } = errorDetail(payload)
    throw new ApiError({
      url,
      status: res.status,
      label: opts.label ?? url,
      detail,
      body: json,
      name,
    })
  }
  return (json ?? {}) as T
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
}

export const api = {
  get<T>(path: string, opts?: ApiRequestOptions): Promise<T> {
    return requestJson<T>(path, { method: "GET" }, opts)
  },
  post<T>(path: string, body?: unknown, opts?: ApiRequestOptions): Promise<T> {
    return requestJson<T>(path, jsonInit("POST", body), opts)
  },
  put<T>(path: string, body?: unknown, opts?: ApiRequestOptions): Promise<T> {
    return requestJson<T>(path, jsonInit("PUT", body), opts)
  },
  patch<T>(path: string, body?: unknown, opts?: ApiRequestOptions): Promise<T> {
    return requestJson<T>(path, jsonInit("PATCH", body), opts)
  },
  delete<T>(
    path: string,
    body?: unknown,
    opts?: ApiRequestOptions,
  ): Promise<T> {
    return requestJson<T>(path, jsonInit("DELETE", body), opts)
  },
  form<T>(path: string, body: FormData, opts?: ApiRequestOptions): Promise<T> {
    return requestJson<T>(path, { method: "POST", body }, opts)
  },
  async getOr<T>(
    path: string,
    fallback: T,
    opts?: ApiRequestOptions,
  ): Promise<T> {
    try {
      return await requestJson<T>(path, { method: "GET" }, opts)
    } catch {
      return fallback
    }
  },
}
