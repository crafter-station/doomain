import { Effect } from 'effect'

import { type DoomainEffect, trySync } from '../effect.js'
import { DoomainError } from '../errors.js'
import { ensureProviderId } from '../validate.js'
import { cloudflareProviderDefinition } from './cloudflare/index.js'
import { createProviderContext } from './core/config.js'
import { hostingerProviderDefinition } from './hostinger/index.js'
import { namecheapProviderDefinition } from './namecheap/index.js'
import { spaceshipProviderDefinition } from './spaceship/index.js'
import type { DnsProvider, DnsProviderDefinition } from './types.js'

const definitions = [
  spaceshipProviderDefinition,
  namecheapProviderDefinition,
  cloudflareProviderDefinition,
  hostingerProviderDefinition,
]

export function listProviderDefinitions(): DnsProviderDefinition[] {
  return definitions
}

export function getProviderDefinition(id: string): DnsProviderDefinition {
  const providerId = ensureProviderId(id)
  const definition = definitions.find((provider) => provider.id === providerId)
  if (!definition) throw new DoomainError('PROVIDER_NOT_FOUND', `Unsupported DNS provider: ${id}`)
  return definition
}

export function createProvider(id: string, opts: { account?: string } = {}): DoomainEffect<DnsProvider> {
  return Effect.gen(function* () {
    const definition = yield* trySync(() => getProviderDefinition(id), 'PROVIDER_NOT_FOUND')
    return definition.create(yield* createProviderContext(definition, opts))
  })
}
