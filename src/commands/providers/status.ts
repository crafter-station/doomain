import {Command, Flags} from '@oclif/core'

import {jsonFlag} from '../../lib/flags.js'
import {createOutput} from '../../lib/output.js'
import {listProviderStatuses, type ProviderStatus} from '../../lib/providers/status.js'

function formatStatus(provider: ProviderStatus): string {
  if (!provider.configured) return 'not connected'
  if (provider.verified === undefined) return 'configured'
  if (!provider.verified) return `failed: ${provider.error}`
  return `verified${provider.domainCount === undefined ? '' : `, ${provider.domainCount} domains`}`
}

export default class ProvidersStatus extends Command {
  static description = 'Show configured DNS providers and credential health.'

  static flags = {
    json: jsonFlag,
    'no-verify': Flags.boolean({description: 'Skip provider API calls and only show local configuration status.'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ProvidersStatus)
    const out = createOutput({json: flags.json})
    const spinner = out.json || flags['no-verify'] ? undefined : out.spinner()

    spinner?.start('Checking DNS providers')
    const providers = await listProviderStatuses({verify: !flags['no-verify']})
    spinner?.stop('Checked DNS providers')

    for (const provider of providers) out.info(`${provider.displayName} (${provider.id}) - ${formatStatus(provider)}${provider.default ? ' [default]' : ''}`)

    out.result({providers})
  }
}
