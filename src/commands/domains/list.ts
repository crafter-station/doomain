import {Command} from '@oclif/core'

import {loadConfig} from '../../lib/config.js'
import {domainFlag, jsonFlag, providerFlag} from '../../lib/flags.js'
import {createOutput, outputError} from '../../lib/output.js'
import {createProvider} from '../../lib/providers/registry.js'
import {normalizeDomain} from '../../lib/validate.js'

export default class DomainsList extends Command {
  static description = 'List DNS zones and records for a provider.'

  static flags = {
    domain: domainFlag,
    json: jsonFlag,
    provider: providerFlag,
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(DomainsList)
    const out = createOutput({json: flags.json})

    try {
      const config = await loadConfig()
      const provider = await createProvider(flags.provider ?? process.env.DOOMAIN_PROVIDER ?? config.defaults?.provider ?? 'spaceship')
      const zones = flags.domain ? [{id: normalizeDomain(flags.domain), name: normalizeDomain(flags.domain)}] : await provider.listZones()
      const results = []

      for (const zone of zones) {
        const records = await provider.listRecords(zone)
        results.push({zone, records})
        out.info(`${zone.name} (${records.length} records)`)
        for (const record of records) out.info(`  ${record.type} ${record.name} -> ${record.value}`)
      }

      out.result({provider: provider.id, zones: results})
    } catch (error) {
      outputError(out.json, error, 'DOMAIN_LINK_FAILED')
      this.exit(1)
    }
  }
}
