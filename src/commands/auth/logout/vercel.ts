import {Command} from '@oclif/core'

import {getConfigPath, updateConfig} from '../../../lib/config.js'
import {jsonFlag} from '../../../lib/flags.js'
import {createOutput, outputError} from '../../../lib/output.js'

function envOverrides(): string[] {
  return ['VERCEL_TOKEN', 'VERCEL_TEAM_ID'].filter((key) => process.env[key])
}

export default class AuthLogoutVercel extends Command {
  static description = 'Remove saved Vercel credentials locally.'

  static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --json']

  static flags = {
    json: jsonFlag,
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(AuthLogoutVercel)
    const out = createOutput({json: flags.json})

    try {
      let removed = false

      await updateConfig((config) => {
        removed = config.vercel !== undefined
        const {vercel: _vercel, ...next} = config
        return next
      })

      const overrides = envOverrides()
      out.result({configPath: getConfigPath(), environmentOverrides: overrides, removed, service: 'vercel'})
      if (overrides.length > 0) out.warn(`Vercel environment credentials are still set: ${overrides.join(', ')}.`)
      out.success(removed ? `Vercel credentials removed from ${getConfigPath()}.` : 'Vercel credentials were not saved.')
    } catch (error) {
      outputError(out.json, error, 'MISSING_CREDENTIALS')
      this.exit(1)
    }
  }
}
