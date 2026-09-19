import { type DoomainConfig, loadConfig } from '../config.js'
import {
  DEFAULT_PROVIDER_ACCOUNT,
  isProviderAccountConfigured,
  listConfiguredProviderAccounts,
  normalizeProviderAccount,
} from './core/config.js'
import { createProvider, listProviderDefinitions } from './registry.js'
import type { DnsProviderDefinition } from './types.js'

export interface ProviderStatus {
  account: string
  accountLabel: string
  configured: boolean
  /** @deprecated Use isPreferredProvider. */
  default: boolean
  displayName: string
  docsUrl?: string
  domainCount?: number
  error?: string
  id: string
  isDefaultAccount: boolean
  isPreferredProvider: boolean
  verified?: boolean
}

export function isProviderConfigured(
  definition: DnsProviderDefinition,
  config: DoomainConfig,
  opts: { account?: string } = {},
): boolean {
  return isProviderAccountConfigured(definition, config, opts)
}

export async function listProviderStatuses(opts: { verify?: boolean } = {}): Promise<ProviderStatus[]> {
  const config = await loadConfig()
  const statuses: ProviderStatus[] = []

  for (const definition of listProviderDefinitions()) {
    const accounts = listConfiguredProviderAccounts(config, definition)
    const refs =
      accounts.length > 0
        ? accounts
        : [{ account: DEFAULT_PROVIDER_ACCOUNT, isDefaultAccount: true, providerId: definition.id }]

    for (const ref of refs) {
      const account = normalizeProviderAccount(ref.account)
      const configured = accounts.some((item) => item.account === account)
      const status: ProviderStatus = {
        account,
        accountLabel: ref.isDefaultAccount ? `${definition.id}/default` : `${definition.id}/${account}`,
        configured,
        default: config.defaults?.provider === definition.id,
        displayName: definition.displayName,
        docsUrl: definition.docsUrl,
        id: definition.id,
        isDefaultAccount: ref.isDefaultAccount,
        isPreferredProvider: config.defaults?.provider === definition.id,
      }

      if (configured && opts.verify) {
        try {
          const zones = await (await createProvider(definition.id, { account })).listZones()
          status.domainCount = zones.length
          status.verified = true
        } catch (error) {
          status.error = error instanceof Error ? error.message : String(error)
          status.verified = false
        }
      }

      statuses.push(status)
    }
  }

  return statuses
}
