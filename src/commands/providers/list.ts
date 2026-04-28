import {Command} from '@oclif/core'

import {jsonFlag} from '../../lib/flags.js'
import {listProviderDefinitions} from '../../lib/providers/registry.js'
import {createOutput} from '../../lib/output.js'

export default class ProvidersList extends Command {
  static description = 'List supported DNS providers.'

  static flags = {
    json: jsonFlag,
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ProvidersList)
    const out = createOutput({json: flags.json})
    const providers = listProviderDefinitions().map((provider) => ({
      capabilities: provider.capabilities,
      credentials: provider.credentials,
      docsUrl: provider.docsUrl,
      id: provider.id,
      displayName: provider.displayName,
      name: provider.name,
    }))

    for (const provider of providers) out.info(`${provider.id} - ${provider.displayName}`)
    out.result({providers})
  }
}
