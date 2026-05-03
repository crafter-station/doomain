import {loadConfig, type DoomainConfig, type ProviderConfig} from '../../config.js'
import {DoomainError} from '../../errors.js'
import {ensureProviderAccount} from '../../validate.js'
import type {CredentialDefinition, DnsProviderDefinition, ProviderContext} from './types.js'

export const DEFAULT_PROVIDER_ACCOUNT = 'default'

export interface ProviderAccountRef {
  account: string
  isDefaultAccount: boolean
  providerId: string
}

export interface ProviderAccountOptions {
  account?: string
}

export function normalizeProviderAccount(account?: string): string {
  if (!account?.trim()) return DEFAULT_PROVIDER_ACCOUNT
  return ensureProviderAccount(account)
}

export function isDefaultProviderAccount(account?: string): boolean {
  return normalizeProviderAccount(account) === DEFAULT_PROVIDER_ACCOUNT
}

function providerConfig(config: DoomainConfig, providerId: string): ProviderConfig | undefined {
  const value = config.providers?.[providerId]
  return value && typeof value === 'object' ? (value as ProviderConfig) : undefined
}

function legacyCredential(config: DoomainConfig, providerId: string, key: string): string | undefined {
  if (providerId !== 'spaceship') return undefined
  const legacy = config.providers?.spaceship
  if (!legacy || typeof legacy !== 'object') return undefined
  return (legacy as Record<string, unknown>)[key] as string | undefined
}

function credentialFromSavedConfig(config: DoomainConfig, providerId: string, account: string, key: string): string | undefined {
  const credentials = getProviderCredentials(config, providerId, {account})
  if (credentials[key]) return credentials[key]
  if (account === DEFAULT_PROVIDER_ACCOUNT) return legacyCredential(config, providerId, key)
  return undefined
}

function hasCredentials(credentials?: Record<string, string>): boolean {
  return credentials !== undefined && Object.keys(credentials).length > 0
}

export function getProviderCredentials(
  config: DoomainConfig,
  providerId: string,
  opts: ProviderAccountOptions = {},
): Record<string, string> {
  const account = normalizeProviderAccount(opts.account)
  const current = providerConfig(config, providerId)
  const credentials = account === DEFAULT_PROVIDER_ACCOUNT ? current?.credentials : current?.accounts?.[account]?.credentials

  return {...(credentials ?? {})}
}

export function getProviderCredential(
  config: DoomainConfig,
  providerId: string,
  credential: CredentialDefinition,
  opts: ProviderAccountOptions = {},
): string | undefined {
  const account = normalizeProviderAccount(opts.account)
  return process.env[credential.env] || credentialFromSavedConfig(config, providerId, account, credential.key)
}

export function providerAccountHasCredentials(config: DoomainConfig, providerId: string, accountInput?: string): boolean {
  const account = normalizeProviderAccount(accountInput)
  const current = providerConfig(config, providerId)
  if (!current) return false

  if (account !== DEFAULT_PROVIDER_ACCOUNT) return hasCredentials(current.accounts?.[account]?.credentials)

  return hasCredentials(current.credentials) || Boolean(legacyCredential(config, providerId, 'apiKey') || legacyCredential(config, providerId, 'apiSecret'))
}

export function withProviderAccountCredentials(
  current: ProviderConfig | undefined,
  accountInput: string,
  credentials: Record<string, string>,
): ProviderConfig {
  const account = normalizeProviderAccount(accountInput)
  if (account === DEFAULT_PROVIDER_ACCOUNT) return {...current, credentials}

  return {
    ...current,
    accounts: {
      ...current?.accounts,
      [account]: {credentials},
    },
  }
}

export function isProviderAccountConfigured(
  definition: DnsProviderDefinition,
  config: DoomainConfig,
  opts: ProviderAccountOptions = {},
): boolean {
  return definition.credentials.every(
    (credential) => credential.required === false || Boolean(getProviderCredential(config, definition.id, credential, opts)),
  )
}

export function listConfiguredProviderAccounts(config: DoomainConfig, definition: DnsProviderDefinition): ProviderAccountRef[] {
  const accounts: ProviderAccountRef[] = []

  if (isProviderAccountConfigured(definition, config, {account: DEFAULT_PROVIDER_ACCOUNT})) {
    accounts.push({account: DEFAULT_PROVIDER_ACCOUNT, isDefaultAccount: true, providerId: definition.id})
  }

  for (const account of Object.keys(providerConfig(config, definition.id)?.accounts ?? {}).sort()) {
    const normalized = normalizeProviderAccount(account)
    if (normalized === DEFAULT_PROVIDER_ACCOUNT) continue
    if (!isProviderAccountConfigured(definition, config, {account: normalized})) continue
    accounts.push({account: normalized, isDefaultAccount: false, providerId: definition.id})
  }

  return accounts
}

export async function createProviderContext(
  definition: DnsProviderDefinition,
  opts: ProviderAccountOptions = {},
): Promise<ProviderContext> {
  const config = await loadConfig()
  const credentials: Record<string, string> = {}
  const account = normalizeProviderAccount(opts.account)

  for (const credential of definition.credentials) {
    const value = getProviderCredential(config, definition.id, credential, {account})
    if (value) credentials[credential.key] = value
    else if (credential.required !== false) {
      const accountHint = account === DEFAULT_PROVIDER_ACCOUNT ? '' : ` for account ${account}`
      throw new DoomainError(
        'MISSING_CREDENTIALS',
        `Missing ${definition.displayName} ${credential.label}${accountHint}. Run \`doomain providers connect ${definition.id}${account === DEFAULT_PROVIDER_ACCOUNT ? '' : ` --account ${account}`}\` or set ${credential.env}.`,
        {account, provider: definition.id},
      )
    }
  }

  return {credentials, debug: process.env.DOOMAIN_DEBUG === '1'}
}
