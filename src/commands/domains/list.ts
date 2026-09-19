import { Command } from '@oclif/core'

import { loadConfig } from '../../lib/config.js'
import { runDoomainEffect } from '../../lib/effect.js'
import { accountFlag, domainFlag, jsonFlag, providerFlag } from '../../lib/flags.js'
import { createOutput, outputError } from '../../lib/output.js'
import {
  DEFAULT_PROVIDER_ACCOUNT,
  isDefaultProviderAccount,
  listConfiguredProviderAccounts,
  normalizeProviderAccount,
  type ProviderAccountRef,
} from '../../lib/providers/core/config.js'
import { createProvider, getProviderDefinition } from '../../lib/providers/registry.js'
import type { DnsProvider, DnsZone } from '../../lib/providers/types.js'
import { normalizeDomain } from '../../lib/validate.js'

async function resolveZones(provider: DnsProvider, domain?: string): Promise<DnsZone[]> {
  if (!domain) return runDoomainEffect(provider.listZones())

  const normalized = normalizeDomain(domain)
  const zone = await runDoomainEffect(provider.getZone(normalized))
  if (!zone) throw new Error(`${provider.name} does not have a DNS zone for ${normalized}.`)
  return [zone]
}

export default class DomainsList extends Command {
  static description = 'List DNS zones and records for a provider.'

  static flags = {
    account: accountFlag,
    domain: domainFlag,
    json: jsonFlag,
    provider: providerFlag,
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(DomainsList)
    const out = createOutput({ json: flags.json })

    try {
      const config = await runDoomainEffect(loadConfig())
      const providerId = flags.provider ?? process.env.DOOMAIN_PROVIDER ?? config.defaults?.provider ?? 'spaceship'
      const definition = getProviderDefinition(providerId)
      const account = flags.account ? normalizeProviderAccount(flags.account) : undefined
      const accounts: ProviderAccountRef[] = account
        ? [{ account, isDefaultAccount: isDefaultProviderAccount(account), providerId: definition.id }]
        : listConfiguredProviderAccounts(config, definition)
      const selectedAccounts =
        accounts.length > 0
          ? accounts
          : [{ account: DEFAULT_PROVIDER_ACCOUNT, isDefaultAccount: true, providerId: definition.id }]
      const results = []

      for (const selectedAccount of selectedAccounts) {
        const provider = await runDoomainEffect(createProvider(definition.id, { account: selectedAccount.account }))
        const zones = await resolveZones(provider, flags.domain)

        for (const zone of zones) {
          const records = await runDoomainEffect(provider.listRecords(zone))
          results.push({
            account: selectedAccount.account,
            isDefaultAccount: selectedAccount.isDefaultAccount,
            provider: provider.id,
            records,
            zone,
          })
          const accountLabel = selectedAccount.isDefaultAccount
            ? provider.id
            : `${provider.id}/${selectedAccount.account}`
          out.info(`${zone.name} (${records.length} records) via ${accountLabel}`)
          for (const record of records) out.info(`  ${record.type} ${record.name} -> ${record.value}`)
        }
      }

      out.result({
        ...(selectedAccounts.length === 1
          ? { account: selectedAccounts[0].account, isDefaultAccount: selectedAccounts[0].isDefaultAccount }
          : {}),
        provider: definition.id,
        zones: results,
      })
    } catch (error) {
      outputError(out.json, error, 'DOMAIN_LINK_FAILED')
      this.exit(1)
    }
  }
}
