export type DmlinkErrorCode =
  | 'CONFIG_NOT_FOUND'
  | 'DOMAIN_LINK_FAILED'
  | 'DOMAIN_VERIFY_FAILED'
  | 'INVALID_INPUT'
  | 'MISSING_ARGUMENT'
  | 'MISSING_CREDENTIALS'
  | 'PROVIDER_API_ERROR'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_PERMISSION_DENIED'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_RECORD_CONFLICT'
  | 'PROVIDER_UNSUPPORTED_RECORD'
  | 'PROVIDER_ZONE_AMBIGUOUS'
  | 'PROVIDER_ZONE_NOT_FOUND'
  | 'PROJECT_NOT_FOUND'
  | 'VERCEL_PROJECT_NOT_LINKED'

export class DmlinkError extends Error {
  readonly code: DmlinkErrorCode
  readonly details?: unknown

  constructor(code: DmlinkErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'DmlinkError'
    this.code = code
    this.details = details
  }
}

export function toDmlinkError(error: unknown, fallbackCode: DmlinkErrorCode): DmlinkError {
  if (error instanceof DmlinkError) return error
  if (error instanceof Error) return new DmlinkError(fallbackCode, error.message)
  return new DmlinkError(fallbackCode, String(error))
}
