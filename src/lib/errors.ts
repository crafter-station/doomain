export type DoomainErrorCode =
  | 'CONFIG_NOT_FOUND'
  | 'CLERK_AUTH_FAILED'
  | 'CLERK_PRODUCTION_EXISTS'
  | 'DNS_POINT_FAILED'
  | 'DNS_REMOVE_FAILED'
  | 'DNS_DELETE_AMBIGUOUS'
  | 'DNS_DIAGNOSE_FAILED'
  | 'DNS_RECONCILIATION_INCOMPLETE'
  | 'DNS_TARGET_CONFLICT'
  | 'DOMAIN_LINK_FAILED'
  | 'DOMAIN_PROVIDER_DISCOVERY_FAILED'
  | 'DOMAIN_ALREADY_ASSIGNED'
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
  | 'SELF_UPDATE_FAILED'
  | 'VERCEL_AUTH_FAILED'
  | 'VERCEL_PROJECT_NOT_LINKED'

export class DoomainError extends Error {
  readonly code: DoomainErrorCode
  readonly details?: unknown

  constructor(code: DoomainErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'DoomainError'
    this.code = code
    this.details = details
  }
}

export function toDoomainError(error: unknown, fallbackCode: DoomainErrorCode): DoomainError {
  if (error instanceof DoomainError) return error
  if (error instanceof Error) return new DoomainError(fallbackCode, error.message)
  return new DoomainError(fallbackCode, String(error))
}
