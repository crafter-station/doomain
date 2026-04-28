import {DmlinkError} from '../errors.js'
import {ensureProviderId} from '../validate.js'
import {cloudflareProviderDefinition} from './cloudflare/index.js'
import {createProviderContext} from './core/config.js'
import {namecheapProviderDefinition} from './namecheap/index.js'
import {spaceshipProviderDefinition} from './spaceship/index.js'
import type {DnsProvider, DnsProviderDefinition} from './types.js'

const definitions = [spaceshipProviderDefinition, namecheapProviderDefinition, cloudflareProviderDefinition]

export function listProviderDefinitions(): DnsProviderDefinition[] {
  return definitions
}

export function getProviderDefinition(id: string): DnsProviderDefinition {
  const providerId = ensureProviderId(id)
  const definition = definitions.find((provider) => provider.id === providerId)
  if (!definition) throw new DmlinkError('PROVIDER_NOT_FOUND', `Unsupported DNS provider: ${id}`)
  return definition
}

export async function createProvider(id: string): Promise<DnsProvider> {
  const definition = getProviderDefinition(id)
  return definition.create(await createProviderContext(definition))
}
