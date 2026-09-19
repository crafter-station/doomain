import { Args, Command } from '@oclif/core'

import { findDomainProvider } from '../../lib/domain-provider.js'
import { runDoomainEffect } from '../../lib/effect.js'
import { DoomainError } from '../../lib/errors.js'
import { accountFlag, domainFlag, jsonFlag, providerFlag } from '../../lib/flags.js'
import { createOutput, outputError } from '../../lib/output.js'

export default class DomainsFind extends Command {
  static args = {
    domain: Args.string({ description: 'Domain whose DNS provider should be found.', required: false }),
  }

  static description = 'Find the configured DNS provider and account for a domain.'

  static examples = [
    '<%= config.bin %> <%= command.id %> example.com --json',
    '<%= config.bin %> <%= command.id %> api.example.com --json',
    '<%= config.bin %> <%= command.id %> --domain example.com --provider spaceship --json',
  ]

  static flags = {
    account: accountFlag,
    domain: domainFlag,
    json: jsonFlag,
    provider: providerFlag,
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DomainsFind)
    const out = createOutput({ json: flags.json })

    try {
      const domain = flags.domain ?? args.domain
      if (!domain)
        throw new DoomainError('MISSING_ARGUMENT', 'Domain is required. Pass it as an argument or use --domain.')

      const result = await runDoomainEffect(
        findDomainProvider({ account: flags.account, domain, provider: flags.provider }),
      )
      const account = result.isDefaultAccount ? result.provider : `${result.provider}/${result.account}`
      out.info(`${result.domain} is managed by ${account} in DNS zone ${result.zoneDomain}.`)
      for (const warning of result.warnings) {
        const warningAccount = warning.isDefaultAccount ? warning.provider : `${warning.provider}/${warning.account}`
        out.warn(`${warningAccount} could not be checked: ${warning.error.message}`)
      }
      out.result(result)
    } catch (error) {
      outputError(out.json, error, 'DOMAIN_PROVIDER_DISCOVERY_FAILED')
      this.exit(1)
    }
  }
}
