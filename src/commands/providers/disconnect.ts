import { Args, Command } from '@oclif/core'

import { getConfigPath, updateConfig } from '../../lib/config.js'
import { runDoomainEffect } from '../../lib/effect.js'
import { accountFlag, jsonFlag } from '../../lib/flags.js'
import { createOutput, outputError } from '../../lib/output.js'
import { isDefaultProviderAccount, normalizeProviderAccount } from '../../lib/providers/core/config.js'
import { getProviderDefinition } from '../../lib/providers/registry.js'

function envOverrides(definition: ReturnType<typeof getProviderDefinition>): string[] {
  return definition.credentials.flatMap((credential) => (process.env[credential.env] ? [credential.env] : []))
}

export default class ProvidersDisconnect extends Command {
  static aliases = ['providers logout']

  static args = {
    provider: Args.string({ description: 'Provider id, for example namecheap.', required: true }),
  }

  static description = 'Remove saved DNS provider credentials locally.'

  static examples = [
    '<%= config.bin %> <%= command.id %> namecheap',
    '<%= config.bin %> <%= command.id %> cloudflare --json',
  ]

  static flags = {
    account: accountFlag,
    json: jsonFlag,
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ProvidersDisconnect)
    const out = createOutput({ json: flags.json })

    try {
      const definition = getProviderDefinition(args.provider)
      const account = flags.account ? normalizeProviderAccount(flags.account) : undefined
      let removed = false

      await runDoomainEffect(
        updateConfig((config) => {
          const providers = { ...config.providers }
          const provider = providers[definition.id]

          if (!account) {
            removed = provider !== undefined
            delete providers[definition.id]
          } else if (provider) {
            const nextProvider = { ...provider }
            if (isDefaultProviderAccount(account)) {
              removed =
                nextProvider.credentials !== undefined ||
                (definition.id === 'spaceship' && ('apiKey' in nextProvider || 'apiSecret' in nextProvider))
              delete nextProvider.credentials
              if (definition.id === 'spaceship') {
                delete (nextProvider as Record<string, unknown>).apiKey
                delete (nextProvider as Record<string, unknown>).apiSecret
                delete (nextProvider as Record<string, unknown>).domains
              }
            } else {
              const accounts = { ...nextProvider.accounts }
              removed = accounts[account] !== undefined
              delete accounts[account]
              nextProvider.accounts = Object.keys(accounts).length > 0 ? accounts : undefined
            }

            if (
              nextProvider.credentials ||
              nextProvider.settings ||
              (nextProvider.accounts && Object.keys(nextProvider.accounts).length > 0)
            ) {
              providers[definition.id] = nextProvider
            } else {
              delete providers[definition.id]
            }
          }

          const defaults = { ...config.defaults }
          if (defaults.provider === definition.id && providers[definition.id] === undefined) delete defaults.provider

          return {
            ...config,
            defaults: Object.keys(defaults).length > 0 ? defaults : undefined,
            providers: Object.keys(providers).length > 0 ? providers : undefined,
          }
        }),
      )

      const overrides = envOverrides(definition)
      out.result({
        account,
        configPath: getConfigPath(),
        environmentOverrides: overrides,
        provider: definition.id,
        removed,
      })
      if (overrides.length > 0)
        out.warn(`${definition.displayName} environment credentials are still set: ${overrides.join(', ')}.`)
      out.success(
        removed
          ? `${definition.displayName} credentials removed from ${getConfigPath()}.`
          : `${definition.displayName} was not connected.`,
      )
    } catch (error) {
      outputError(out.json, error, 'PROVIDER_NOT_FOUND')
      this.exit(1)
    }
  }
}
