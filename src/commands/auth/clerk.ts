import * as p from '@clack/prompts'
import { Command, Flags } from '@oclif/core'

import { createClerkPlatformClient } from '../../lib/clerk.js'
import { getConfigPath, maskSecret, updateConfig } from '../../lib/config.js'
import { runDoomainEffect } from '../../lib/effect.js'
import { jsonFlag } from '../../lib/flags.js'
import { createOutput, outputError } from '../../lib/output.js'

function value(input: string | undefined, message: string): string {
  const resolved = input?.trim()
  if (!resolved) throw new Error(message)
  return resolved
}

export default class AuthClerk extends Command {
  static description = 'Save Clerk Platform API credentials locally.'

  static examples = ['<%= config.bin %> <%= command.id %> --platform-api-key ak_123 --app app_123 --json']

  static flags = {
    app: Flags.string({ description: 'Default Clerk application id.' }),
    json: jsonFlag,
    'platform-api-key': Flags.string({ description: 'Clerk Platform API key (ak_...).' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(AuthClerk)
    const out = createOutput({ json: flags.json })

    try {
      let platformApiKey = flags['platform-api-key'] ?? process.env.CLERK_PLATFORM_API_KEY
      let appId = flags.app ?? process.env.CLERK_APPLICATION_ID

      if (!out.json) {
        if (!platformApiKey) {
          const entered = await p.password({ message: 'Clerk Platform API key' })
          if (p.isCancel(entered)) return
          platformApiKey = entered
        }

        if (!appId) {
          const entered = await p.text({ message: 'Default Clerk application id' })
          if (p.isCancel(entered)) return
          appId = entered
        }
      }

      platformApiKey = value(
        platformApiKey,
        'Missing Clerk Platform API key. Pass --platform-api-key or set CLERK_PLATFORM_API_KEY.',
      )
      appId = value(appId, 'Missing Clerk application id. Pass --app or set CLERK_APPLICATION_ID.')
      if (!platformApiKey.startsWith('ak_')) throw new Error('Clerk Platform API keys must start with ak_.')

      await runDoomainEffect(
        createClerkPlatformClient({ platformApiKey }, { transportErrorCode: 'CLERK_AUTH_FAILED' }).fetchApplication(
          appId,
        ),
      )
      await runDoomainEffect(
        updateConfig((config) => ({ ...config, clerk: { appId, platformApiKey } }), 'CLERK_AUTH_FAILED'),
      )
      out.result({ clerk: { appId, platformApiKey: maskSecret(platformApiKey) }, configPath: getConfigPath() })
      out.success(`Clerk credentials saved to ${getConfigPath()}.`)
    } catch (error) {
      outputError(out.json, error, 'CLERK_AUTH_FAILED')
      this.exit(1)
    }
  }
}
