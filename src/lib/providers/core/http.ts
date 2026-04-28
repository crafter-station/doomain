import {ProviderError, providerCodeFromStatus} from './errors.js'

export interface ProviderHttpClientOptions {
  baseUrl: string
  errorMessages?: Partial<Record<number, string>>
  headers?: Record<string, string>
  providerId: string
  signal?: AbortSignal
}

export interface ProviderRequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
  query?: Record<string, number | string | undefined>
}

function appendQuery(path: string, query?: ProviderRequestOptions['query']): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }

  if (params.size === 0) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}${params.toString()}`
}

export class ProviderHttpClient {
  constructor(private readonly opts: ProviderHttpClientOptions) {}

  async request<T>(path: string, init: ProviderRequestOptions = {}): Promise<T> {
    const {body, headers, query, ...rest} = init
    const response = await fetch(`${this.opts.baseUrl}${appendQuery(path, query)}`, {
      ...rest,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        ...this.opts.headers,
        ...(headers as Record<string, string> | undefined),
      },
      signal: init.signal ?? this.opts.signal,
    })

    if (!response.ok) {
      const details = await response.json().catch(() => undefined)
      throw new ProviderError(
        this.opts.providerId,
        providerCodeFromStatus(response.status),
        this.opts.errorMessages?.[response.status] ?? `${this.opts.providerId} API error (${response.status}).`,
        details,
      )
    }

    if (response.status === 204) return undefined as T
    return (await response.json().catch(() => undefined)) as T
  }
}

export function createProviderHttpClient(opts: ProviderHttpClientOptions): ProviderHttpClient {
  return new ProviderHttpClient(opts)
}
