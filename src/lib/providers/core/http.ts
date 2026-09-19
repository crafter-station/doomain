import { Effect } from 'effect'

import type { DoomainEffect } from '../../effect.js'
import { type DoomainErrorCode, toDoomainError } from '../../errors.js'
import { ProviderError, providerCodeFromStatus } from './errors.js'

export interface ProviderHttpClientOptions {
  baseUrl: string
  errorMessages?: Partial<Record<number, string>>
  headers?: Record<string, string>
  providerId: string
  signal?: AbortSignal
  transportErrorCode?: DoomainErrorCode
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

  request<T>(path: string, init: ProviderRequestOptions = {}): DoomainEffect<T> {
    return Effect.gen(this, function* () {
      const { body, headers, query, ...rest } = init
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(`${this.opts.baseUrl}${appendQuery(path, query)}`, {
            ...rest,
            body: body === undefined ? undefined : JSON.stringify(body),
            headers: {
              'Content-Type': 'application/json',
              ...this.opts.headers,
              ...(headers as Record<string, string> | undefined),
            },
            signal: init.signal ?? this.opts.signal ?? signal,
          }),
        catch: (cause) => toDoomainError(cause, this.opts.transportErrorCode ?? 'PROVIDER_API_ERROR'),
      })

      if (!response.ok) {
        const details = yield* Effect.tryPromise(() => response.json()).pipe(
          Effect.catchAll(() => Effect.succeed(undefined)),
        )
        return yield* Effect.fail(
          new ProviderError(
            this.opts.providerId,
            providerCodeFromStatus(response.status),
            this.opts.errorMessages?.[response.status] ?? `${this.opts.providerId} API error (${response.status}).`,
            details,
          ),
        )
      }

      if (response.status === 204) return undefined as T
      return (yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) => toDoomainError(cause, this.opts.transportErrorCode ?? 'PROVIDER_API_ERROR'),
      })) as T
    })
  }
}

export function createProviderHttpClient(opts: ProviderHttpClientOptions): ProviderHttpClient {
  return new ProviderHttpClient(opts)
}
