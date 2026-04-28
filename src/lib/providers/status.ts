import {loadConfig, type DmlinkConfig} from '../config.js'
import {getProviderCredential} from './core/config.js'
import {createProvider, listProviderDefinitions} from './registry.js'
import type {DnsProviderDefinition} from './types.js'

export interface ProviderStatus {
  configured: boolean
  default: boolean
  displayName: string
  docsUrl?: string
  domainCount?: number
  error?: string
  id: string
  verified?: boolean
}

export function isProviderConfigured(definition: DnsProviderDefinition, config: DmlinkConfig): boolean {
  return definition.credentials.every(
    (credential) => credential.required === false || Boolean(getProviderCredential(config, definition.id, credential)),
  )
}

export async function listProviderStatuses(opts: {verify?: boolean} = {}): Promise<ProviderStatus[]> {
  const config = await loadConfig()
  const statuses: ProviderStatus[] = []

  for (const definition of listProviderDefinitions()) {
    const configured = isProviderConfigured(definition, config)
    const status: ProviderStatus = {
      configured,
      default: config.defaults?.provider === definition.id,
      displayName: definition.displayName,
      docsUrl: definition.docsUrl,
      id: definition.id,
    }

    if (configured && opts.verify) {
      try {
        const zones = await (await createProvider(definition.id)).listZones()
        status.domainCount = zones.length
        status.verified = true
      } catch (error) {
        status.error = error instanceof Error ? error.message : String(error)
        status.verified = false
      }
    }

    statuses.push(status)
  }

  return statuses
}
