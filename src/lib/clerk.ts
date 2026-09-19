import { loadConfig } from './config.js'
import { DoomainError } from './errors.js'

const CLERK_API_URL = 'https://api.clerk.com'

export interface ClerkPlatformConfig {
  appId: string
  platformApiKey: string
}

export interface ClerkApplication {
  application_id: string
  name?: string
  instances: Array<{
    environment_type: string
    instance_id: string
    publishable_key: string
  }>
}

export interface ClerkCnameTarget {
  host: string
  required: boolean
  value: string
}

export interface ClerkApplicationDomain {
  cname_targets?: ClerkCnameTarget[]
  frontend_api_url: string
  id: string
  is_satellite: boolean
  name: string
}

export interface ClerkProductionInstance {
  active_domain: ClerkApplicationDomain | null
  environment_type: 'production'
  id: string
  publishable_key: string
}

export interface ClerkDomainStatus {
  dns?: { required?: boolean; status: string }
  mail?: { required?: boolean; status: string }
  ssl?: { required?: boolean; status: string }
  status: string
}

interface ClerkApiErrorBody {
  code?: string
  error?: { code?: string; message?: string }
  errors?: Array<{ code?: string; long_message?: string; message?: string }>
  message?: string
}

export async function resolveClerkPlatformConfig(appId?: string): Promise<ClerkPlatformConfig> {
  const config = await loadConfig()
  const platformApiKey = process.env.CLERK_PLATFORM_API_KEY || config.clerk?.platformApiKey
  const resolvedAppId = appId || process.env.CLERK_APPLICATION_ID || config.clerk?.appId

  if (!platformApiKey) {
    throw new DoomainError(
      'MISSING_CREDENTIALS',
      'Missing Clerk Platform API key. Run `doomain auth clerk`, set CLERK_PLATFORM_API_KEY, or pass saved credentials.',
    )
  }

  if (!platformApiKey.startsWith('ak_')) {
    throw new DoomainError('INVALID_INPUT', 'Clerk Platform API keys must start with ak_.')
  }

  if (!resolvedAppId) {
    throw new DoomainError(
      'MISSING_ARGUMENT',
      'Clerk application is required. Pass --app, set CLERK_APPLICATION_ID, or save it with `doomain auth clerk`.',
    )
  }

  return { appId: resolvedAppId, platformApiKey }
}

function apiErrorMessage(status: number, body?: ClerkApiErrorBody): string {
  return (
    body?.errors?.[0]?.long_message ??
    body?.errors?.[0]?.message ??
    body?.error?.message ??
    body?.message ??
    `Clerk API error (${status}).`
  )
}

function apiErrorCode(body?: ClerkApiErrorBody): string | undefined {
  return body?.errors?.[0]?.code ?? body?.error?.code ?? body?.code
}

export function createClerkPlatformClient(config: { platformApiKey: string }) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${CLERK_API_URL}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.platformApiKey}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    })

    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as ClerkApiErrorBody | undefined
      if (response.status === 401 || response.status === 403) {
        throw new DoomainError(
          'CLERK_AUTH_FAILED',
          `Clerk Platform API authorization failed. Check CLERK_PLATFORM_API_KEY and its application access. ${apiErrorMessage(response.status, body)}`,
          body,
        )
      }

      if (response.status === 409 && apiErrorCode(body) === 'production_instance_exists') {
        throw new DoomainError(
          'CLERK_PRODUCTION_EXISTS',
          'This Clerk application already has a production instance. Configure domain changes manually in Clerk; Doomain will not modify it.',
          body,
        )
      }

      throw new DoomainError('DOMAIN_LINK_FAILED', apiErrorMessage(response.status, body), body)
    }

    return (await response.json()) as T
  }

  return {
    fetchApplication(appId: string): Promise<ClerkApplication> {
      return request(`/v1/platform/applications/${encodeURIComponent(appId)}`)
    },

    createProductionInstance(
      appId: string,
      domain: string,
      developmentInstanceId: string,
    ): Promise<ClerkProductionInstance> {
      return request(`/v1/platform/applications/${encodeURIComponent(appId)}/instances`, {
        body: JSON.stringify({ clone_instance_id: developmentInstanceId, domain, environment_type: 'production' }),
        method: 'POST',
      })
    },

    getDomainStatus(appId: string, domainId: string): Promise<ClerkDomainStatus> {
      return request(
        `/v1/platform/applications/${encodeURIComponent(appId)}/domains/${encodeURIComponent(domainId)}/status`,
      )
    },

    triggerDomainDnsCheck(appId: string, domainId: string): Promise<ClerkDomainStatus> {
      return request(
        `/v1/platform/applications/${encodeURIComponent(appId)}/domains/${encodeURIComponent(domainId)}/dns_check`,
        { method: 'POST' },
      )
    },
  }
}

export type ClerkPlatformClient = ReturnType<typeof createClerkPlatformClient>
