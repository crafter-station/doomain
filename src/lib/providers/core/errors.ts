import {DmlinkError, type DmlinkErrorCode} from '../../errors.js'

export class ProviderError extends DmlinkError {
  readonly providerId: string

  constructor(providerId: string, code: DmlinkErrorCode, message: string, details?: unknown) {
    super(code, message, details)
    this.name = 'ProviderError'
    this.providerId = providerId
  }
}

export function providerCodeFromStatus(status: number): DmlinkErrorCode {
  if (status === 401) return 'PROVIDER_AUTH_FAILED'
  if (status === 403) return 'PROVIDER_PERMISSION_DENIED'
  if (status === 429) return 'PROVIDER_RATE_LIMITED'
  return 'PROVIDER_API_ERROR'
}
