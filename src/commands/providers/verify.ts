import { Args, Command } from '@oclif/core'
import { runDoomainEffect } from '../../lib/effect.js'
import { accountFlag, jsonFlag } from '../../lib/flags.js'
import { createOutput, outputError } from '../../lib/output.js'
import { isDefaultProviderAccount, normalizeProviderAccount } from '../../lib/providers/core/config.js'
import { createProvider } from '../../lib/providers/registry.js'

export default class ProvidersVerify extends Command {
  static args = {
    provider: Args.string({ description: 'Provider id, for example spaceship.', required: true }),
  }

  static description = 'Verify saved DNS provider credentials.'

  static flags = {
    account: accountFlag,
    json: jsonFlag,
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ProvidersVerify)
    const out = createOutput({ json: flags.json })

    try {
      const account = normalizeProviderAccount(flags.account)
      const provider = await runDoomainEffect(createProvider(args.provider, { account }))
      const health = await runDoomainEffect(provider.verifyCredentials())
      out.result({ account, health, isDefaultAccount: isDefaultProviderAccount(account), provider: provider.id })
      out.success(`${provider.name} credentials verified.`)
    } catch (error) {
      outputError(out.json, error, 'PROVIDER_AUTH_FAILED')
      this.exit(1)
    }
  }
}
