import {loadConfig, type DmlinkConfig} from '../../config.js'
import {DmlinkError} from '../../errors.js'
import type {CredentialDefinition, DnsProviderDefinition, ProviderContext} from './types.js'

function legacyCredential(config: DmlinkConfig, providerId: string, key: string): string | undefined {
  if (providerId !== 'spaceship') return undefined
  const legacy = config.providers?.spaceship
  if (!legacy || typeof legacy !== 'object') return undefined
  return (legacy as Record<string, unknown>)[key] as string | undefined
}

export function getProviderCredentials(config: DmlinkConfig, providerId: string): Record<string, string> {
  const providerConfig = config.providers?.[providerId]
  const credentials =
    providerConfig && typeof providerConfig === 'object' && 'credentials' in providerConfig
      ? ((providerConfig as {credentials?: Record<string, string>}).credentials ?? {})
      : {}

  return {...credentials}
}

export function getProviderCredential(config: DmlinkConfig, providerId: string, credential: CredentialDefinition): string | undefined {
  return process.env[credential.env] || getProviderCredentials(config, providerId)[credential.key] || legacyCredential(config, providerId, credential.key)
}

export async function createProviderContext(definition: DnsProviderDefinition): Promise<ProviderContext> {
  const config = await loadConfig()
  const credentials: Record<string, string> = {}

  for (const credential of definition.credentials) {
    const value = getProviderCredential(config, definition.id, credential)
    if (value) credentials[credential.key] = value
    else if (credential.required !== false) {
      throw new DmlinkError(
        'MISSING_CREDENTIALS',
        `Missing ${definition.displayName} ${credential.label}. Run \`dmlink providers connect ${definition.id}\` or set ${credential.env}.`,
      )
    }
  }

  return {credentials, debug: process.env.DMLINK_DEBUG === '1'}
}
