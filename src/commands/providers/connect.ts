import {Args, Command, Flags} from '@oclif/core'
import * as p from '@clack/prompts'

import {getConfigPath, loadConfig, maskSecret, updateConfig} from '../../lib/config.js'
import {accountFlag, jsonFlag} from '../../lib/flags.js'
import {createOutput, outputError} from '../../lib/output.js'
import {
  DEFAULT_PROVIDER_ACCOUNT,
  isDefaultProviderAccount,
  listConfiguredProviderAccounts,
  normalizeProviderAccount,
  providerAccountHasCredentials,
  withProviderAccountCredentials,
} from '../../lib/providers/core/config.js'
import {getProviderDefinition, listProviderDefinitions} from '../../lib/providers/registry.js'
import type {CredentialDefinition, DnsProviderDefinition} from '../../lib/providers/types.js'

function requireString(value: unknown, message: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw new Error(message)
}

function parseCredentialFlags(values?: string[]): Record<string, string> {
  const credentials: Record<string, string> = {}
  for (const value of values ?? []) {
    const index = value.indexOf('=')
    if (index <= 0) throw new Error(`Invalid --credential value "${value}". Use key=value.`)
    credentials[value.slice(0, index)] = value.slice(index + 1)
  }

  return credentials
}

function legacyFlagValue(flags: Record<string, unknown>, credential: CredentialDefinition): string | undefined {
  const key = credential.key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)
  const value = flags[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

async function fetchPublicIp(): Promise<string | undefined> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2000)

  try {
    const response = await fetch('https://api.ipify.org', {signal: controller.signal})
    if (!response.ok) return undefined
    const ip = (await response.text()).trim()
    return ip || undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

function credentialInitialValue(credential: CredentialDefinition, detectedPublicIp?: string): string | undefined {
  if (credential.key !== 'clientIp') return undefined
  return detectedPublicIp
}

async function promptCredential(credential: CredentialDefinition, detectedPublicIp?: string): Promise<string | null> {
  const initialValue = credential.secret ? undefined : credentialInitialValue(credential, detectedPublicIp)
  const value = credential.secret
    ? await p.password({message: credential.label})
    : await p.text({message: credential.label, initialValue, placeholder: credential.placeholder ?? credential.hint})
  if (p.isCancel(value)) {
    p.cancel('Cancelled')
    return null
  }

  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function validateProviderAccount(value: string | undefined): string | undefined {
  try {
    normalizeProviderAccount(value)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function promptProviderAccount(): Promise<string | null> {
  const value = await p.text({message: 'Profile name', placeholder: DEFAULT_PROVIDER_ACCOUNT, validate: validateProviderAccount})
  if (p.isCancel(value)) {
    p.cancel('Cancelled')
    return null
  }

  return normalizeProviderAccount(value)
}

async function confirmProviderAccountOverwrite(definition: DnsProviderDefinition, account: string): Promise<boolean> {
  const value = await p.confirm({
    initialValue: false,
    message: `Profile "${account}" already exists for ${definition.displayName}. Overwrite it?`,
  })
  if (p.isCancel(value)) {
    p.cancel('Cancelled')
    return false
  }

  return value
}

async function promptProvider(): Promise<DnsProviderDefinition | null> {
  const config = await loadConfig()
  const selected = await p.select({
    message: 'Choose DNS provider',
    options: listProviderDefinitions().map((definition) => ({
      hint: listConfiguredProviderAccounts(config, definition).length > 0 ? 'Connected' : 'Not connected',
      label: definition.displayName,
      value: definition.id,
    })),
  })

  if (p.isCancel(selected)) {
    p.cancel('Cancelled')
    return null
  }

  return getProviderDefinition(selected)
}

function usesClientIp(definition: DnsProviderDefinition): boolean {
  return definition.credentials.some((credential) => credential.key === 'clientIp')
}

function showSetupGuide(definition: DnsProviderDefinition, detectedPublicIp?: string): void {
  if (!definition.setup?.notes?.length) return
  const notes = [...definition.setup.notes]
  if (detectedPublicIp) notes.push(`Detected public IP: ${detectedPublicIp}`)
  p.note(notes.join('\n'), `${definition.displayName} setup`)
}

export default class ProvidersConnect extends Command {
  static args = {
    provider: Args.string({description: 'Provider id, for example spaceship.', required: false}),
  }

  static description = 'Save DNS provider credentials locally.'

  static flags = {
    account: accountFlag,
    'api-key': Flags.string({description: 'Compatibility alias for Spaceship apiKey.'}),
    'api-secret': Flags.string({description: 'Compatibility alias for Spaceship apiSecret.'}),
    credential: Flags.string({char: 'c', description: 'Provider credential as key=value.', multiple: true}),
    json: jsonFlag,
    'no-verify': Flags.boolean({description: 'Save credentials without verifying them first.'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(ProvidersConnect)
    const out = createOutput({json: flags.json})
    let spinner: ReturnType<typeof out.spinner> | undefined

    try {
      if (!args.provider && out.json) throw new Error('Missing provider. Pass a provider id, for example `namecheap`.')
      const definition = args.provider ? getProviderDefinition(args.provider) : await promptProvider()
      if (!definition) return
      const account = flags.account ? normalizeProviderAccount(flags.account) : out.json ? DEFAULT_PROVIDER_ACCOUNT : await promptProviderAccount()
      if (!account) return
      const isDefaultAccount = isDefaultProviderAccount(account)
      const currentConfig = await loadConfig()
      if (!out.json && providerAccountHasCredentials(currentConfig, definition.id, account)) {
        const overwrite = await confirmProviderAccountOverwrite(definition, account)
        if (!overwrite) return
      }

      const passedCredentials = parseCredentialFlags(flags.credential)
      const credentials: Record<string, string> = {}
      const detectedPublicIp = !out.json && usesClientIp(definition) ? await fetchPublicIp() : undefined

      if (!out.json) showSetupGuide(definition, detectedPublicIp)

      for (const credential of definition.credentials) {
        const value =
          process.env[credential.env] || passedCredentials[credential.key] || legacyFlagValue(flags, credential) || undefined

        if (value) {
          credentials[credential.key] = value
          continue
        }

        const initialValue = credentialInitialValue(credential, detectedPublicIp)
        if (initialValue) {
          credentials[credential.key] = initialValue
          continue
        }

        if (out.json || credential.required === false) continue

        const prompted = await promptCredential(credential, detectedPublicIp)
        if (prompted === null) return
        credentials[credential.key] = prompted
      }

      for (const credential of definition.credentials) {
        if (credential.required !== false) {
          credentials[credential.key] = requireString(
            credentials[credential.key],
            `Missing ${definition.displayName} ${credential.label}. Pass --credential ${credential.key}=... or set ${credential.env}.`,
          )
        }
      }

      let domainCount: number | undefined
      if (!flags['no-verify']) {
        spinner = out.json ? undefined : out.spinner()
        spinner?.start(`Verifying ${definition.displayName} credentials`)
        const zones = await definition.create({credentials, debug: process.env.DOOMAIN_DEBUG === '1'}).listZones()
        domainCount = zones.length
        spinner?.stop(`Verified ${definition.displayName} credentials and found ${domainCount} domain${domainCount === 1 ? '' : 's'}`)
        spinner = undefined
      }

      let setDefault = true
      if (!out.json && currentConfig.defaults?.provider && currentConfig.defaults.provider !== definition.id) {
        const value = await p.confirm({
          initialValue: true,
          message: `Set ${definition.displayName} as the default DNS provider?`,
        })
        if (p.isCancel(value)) {
          p.cancel('Cancelled')
          return
        }

        setDefault = value
      }

      await updateConfig((config) => ({
        ...config,
        defaults: setDefault ? {...config.defaults, provider: definition.id} : config.defaults,
        providers: {
          ...config.providers,
          [definition.id]: withProviderAccountCredentials(config.providers?.[definition.id], account, credentials),
        },
      }))

      out.result({
        account,
        configPath: getConfigPath(),
        credentials: Object.fromEntries(Object.entries(credentials).map(([key, value]) => [key, maskSecret(value)])),
        defaultAccount: isDefaultAccount,
        domainCount,
        isDefaultAccount,
        provider: definition.id,
        verified: !flags['no-verify'],
      })
      out.success(`${definition.displayName} credentials saved to ${getConfigPath()}.`)
    } catch (error) {
      spinner?.error('Provider connection failed')
      outputError(out.json, error, 'MISSING_CREDENTIALS')
      this.exit(1)
    }
  }
}
