import { Command } from '@oclif/core'
import { Effect } from 'effect'

import { loadConfig } from '../../lib/config.js'
import { type DoomainEffect, runDoomainEffect, trySync } from '../../lib/effect.js'
import { DoomainError } from '../../lib/errors.js'
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

function resolveZones(provider: DnsProvider, domain?: string): DoomainEffect<DnsZone[]> {
  if (!domain) return provider.listZones()

  return Effect.gen(function* () {
    const normalized = yield* trySync(() => normalizeDomain(domain), 'DOMAIN_LINK_FAILED')
    const zone = yield* provider.getZone(normalized)
    if (!zone) {
      return yield* Effect.fail(
        new DoomainError('DOMAIN_LINK_FAILED', `${provider.name} does not have a DNS zone for ${normalized}.`),
      )
    }

    return [zone]
  })
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
      const { definition, results, selectedAccounts } = await runDoomainEffect(
        Effect.gen(function* () {
          const config = yield* loadConfig()
          const providerId = flags.provider ?? process.env.DOOMAIN_PROVIDER ?? config.defaults?.provider ?? 'spaceship'
          const definition = yield* trySync(() => getProviderDefinition(providerId), 'DOMAIN_LINK_FAILED')
          const account = flags.account
            ? yield* trySync(() => normalizeProviderAccount(flags.account), 'DOMAIN_LINK_FAILED')
            : undefined
          const accounts: ProviderAccountRef[] = account
            ? [{ account, isDefaultAccount: isDefaultProviderAccount(account), providerId: definition.id }]
            : yield* trySync(() => listConfiguredProviderAccounts(config, definition), 'DOMAIN_LINK_FAILED')
          const selectedAccounts =
            accounts.length > 0
              ? accounts
              : [{ account: DEFAULT_PROVIDER_ACCOUNT, isDefaultAccount: true, providerId: definition.id }]
          const results = []

          for (const selectedAccount of selectedAccounts) {
            const provider = yield* createProvider(definition.id, {
              account: selectedAccount.account,
              transportErrorCode: 'DOMAIN_LINK_FAILED',
            })
            const zones = yield* resolveZones(provider, flags.domain)
            for (const zone of zones) {
              results.push({
                account: selectedAccount.account,
                isDefaultAccount: selectedAccount.isDefaultAccount,
                provider: provider.id,
                records: yield* provider.listRecords(zone),
                zone,
              })
            }
          }

          return { definition, results, selectedAccounts }
        }),
      )

      for (const result of results) {
        const accountLabel = result.isDefaultAccount ? result.provider : `${result.provider}/${result.account}`
        out.info(`${result.zone.name} (${result.records.length} records) via ${accountLabel}`)
        for (const record of result.records) out.info(`  ${record.type} ${record.name} -> ${record.value}`)
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
