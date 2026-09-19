import { Command } from '@oclif/core'

import { getConfigPath, updateConfig } from '../../../lib/config.js'
import { jsonFlag } from '../../../lib/flags.js'
import { createOutput, outputError } from '../../../lib/output.js'

export default class AuthLogoutClerk extends Command {
  static description = 'Remove saved Clerk credentials locally.'

  static flags = { json: jsonFlag }

  async run(): Promise<void> {
    const { flags } = await this.parse(AuthLogoutClerk)
    const out = createOutput({ json: flags.json })

    try {
      let removed = false
      await updateConfig((config) => {
        removed = config.clerk !== undefined
        const { clerk: _clerk, ...next } = config
        return next
      })

      const environmentOverrides = ['CLERK_PLATFORM_API_KEY', 'CLERK_APPLICATION_ID'].filter((key) => process.env[key])
      out.result({ configPath: getConfigPath(), environmentOverrides, removed, service: 'clerk' })
      if (environmentOverrides.length > 0)
        out.warn(`Clerk environment credentials are still set: ${environmentOverrides.join(', ')}.`)
      out.success(removed ? `Clerk credentials removed from ${getConfigPath()}.` : 'Clerk credentials were not saved.')
    } catch (error) {
      outputError(out.json, error, 'MISSING_CREDENTIALS')
      this.exit(1)
    }
  }
}
