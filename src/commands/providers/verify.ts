import {Args, Command} from '@oclif/core'

import {jsonFlag} from '../../lib/flags.js'
import {createOutput, outputError} from '../../lib/output.js'
import {createProvider} from '../../lib/providers/registry.js'

export default class ProvidersVerify extends Command {
  static args = {
    provider: Args.string({description: 'Provider id, for example spaceship.', required: true}),
  }

  static description = 'Verify saved DNS provider credentials.'

  static flags = {
    json: jsonFlag,
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(ProvidersVerify)
    const out = createOutput({json: flags.json})

    try {
      const provider = await createProvider(args.provider)
      const health = await provider.verifyCredentials()
      out.result({health, provider: provider.id})
      out.success(`${provider.name} credentials verified.`)
    } catch (error) {
      outputError(out.json, error, 'PROVIDER_AUTH_FAILED')
      this.exit(1)
    }
  }
}
