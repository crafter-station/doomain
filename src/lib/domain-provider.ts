import { Effect } from 'effect'

import { loadConfig } from './config.js'
import { type DoomainEffect, runDoomainEffect, trySync } from './effect.js'
import { DoomainError, type DoomainErrorCode } from './errors.js'
import {
  DEFAULT_PROVIDER_ACCOUNT,
  isDefaultProviderAccount,
  listConfiguredProviderAccounts,
  normalizeProviderAccount,
  type ProviderAccountRef,
} from './providers/core/config.js'
import { createProvider, getProviderDefinition, listProviderDefinitions } from './providers/registry.js'
import { listProviderStatuses } from './providers/status.js'
import type { DnsProviderDefinition, DnsZone } from './providers/types.js'
import { normalizeDomain, normalizeSubdomain } from './validate.js'

export interface FindDomainProviderInput {
  account?: string
  domain: string
  provider?: string
}

export interface ProviderSearchWarning {
  account: string
  error: {
    code?: DoomainErrorCode
    message: string
  }
  isDefaultAccount: boolean
  provider: string
  providerName: string
}

export interface DomainProviderResult {
  account: string
  accountInferred: boolean
  complete: boolean
  domain: string
  isApex: boolean
  isDefaultAccount: boolean
  provider: string
  providerInferred: boolean
  recordName: string
  warnings: ProviderSearchWarning[]
  zoneDomain: string
}

export interface ResolveProviderTargetInput extends FindDomainProviderInput {
  apex?: boolean
  subdomain?: string
}

export interface ResolveProviderTargetOptions {
  tolerateProviderAccountErrors?: boolean
  transportErrorCode?: DoomainErrorCode
}

export interface ResolvedDnsTarget {
  account: string
  accountInferred: boolean
  isDefaultAccount: boolean
  provider: string
  providerInferred: boolean
  target: {
    fullDomain: string
    isApex: boolean
    recordName: string
    zoneDomain: string
  }
  warnings: ProviderSearchWarning[]
}

interface RequestedDomain {
  forceExactZone: boolean
  fullDomain: string
}

interface ProviderZoneCandidate {
  account: string
  isDefaultAccount: boolean
  provider: string
  providerName: string
  zone: DnsZone
}

interface ProviderZoneSearchResult {
  account: string
  displayName: string
  error?: ProviderSearchWarning['error']
  id: string
  isDefaultAccount: boolean
  zones: string[]
}

function resolveRequestedDomain(opts: ResolveProviderTargetInput): RequestedDomain {
  if (opts.apex && opts.subdomain) {
    throw new DoomainError('INVALID_INPUT', 'Use either --apex or --subdomain, not both.')
  }

  const domain = normalizeDomain(opts.domain)
  if (opts.apex) return { forceExactZone: true, fullDomain: domain }
  if (!opts.subdomain) return { forceExactZone: false, fullDomain: domain }

  return { forceExactZone: false, fullDomain: `${normalizeSubdomain(opts.subdomain)}.${domain}` }
}

function zoneMatchesDomain(fullDomain: string, zoneDomain: string, forceExactZone: boolean): boolean {
  if (fullDomain === zoneDomain) return true
  if (forceExactZone) return false
  return fullDomain.endsWith(`.${zoneDomain}`)
}

function targetFromZone(fullDomain: string, zoneDomain: string): ResolvedDnsTarget['target'] {
  if (fullDomain === zoneDomain) {
    return { fullDomain, isApex: true, recordName: '@', zoneDomain }
  }

  return {
    fullDomain,
    isApex: false,
    recordName: fullDomain.slice(0, -(zoneDomain.length + 1)),
    zoneDomain,
  }
}

function candidateDetails(candidates: ProviderZoneCandidate[]) {
  return candidates.map((candidate) => ({
    account: candidate.account,
    isDefaultAccount: candidate.isDefaultAccount,
    provider: candidate.provider,
    providerName: candidate.providerName,
    zoneDomain: candidate.zone.name,
  }))
}

function defaultAccountRef(providerId: string): ProviderAccountRef {
  return { account: DEFAULT_PROVIDER_ACCOUNT, isDefaultAccount: true, providerId }
}

function explicitAccountRef(providerId: string, account: string): ProviderAccountRef {
  const normalized = normalizeProviderAccount(account)
  return { account: normalized, isDefaultAccount: isDefaultProviderAccount(normalized), providerId }
}

function searchError(error: unknown): ProviderSearchWarning['error'] {
  return {
    ...(error instanceof DoomainError ? { code: error.code } : {}),
    message: error instanceof Error ? error.message : String(error),
  }
}

function loadProviderZones(
  definition: DnsProviderDefinition,
  account: ProviderAccountRef,
  transportErrorCode: DoomainErrorCode,
): DoomainEffect<{
  candidates: ProviderZoneCandidate[]
  search: ProviderZoneSearchResult
}> {
  return Effect.gen(function* () {
    const provider = yield* createProvider(definition.id, { account: account.account, transportErrorCode })
    const zones = yield* provider.listZones()
    return {
      candidates: zones.map((zone) => ({
        account: account.account,
        isDefaultAccount: account.isDefaultAccount,
        provider: definition.id,
        providerName: definition.displayName,
        zone,
      })),
      search: {
        account: account.account,
        displayName: definition.displayName,
        id: definition.id,
        isDefaultAccount: account.isDefaultAccount,
        zones: zones.map((zone) => zone.name),
      },
    }
  })
}

function loadProviderZonesSafely(
  definition: DnsProviderDefinition,
  account: ProviderAccountRef,
  transportErrorCode: DoomainErrorCode,
) {
  return loadProviderZones(definition, account, transportErrorCode).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({
        candidates: [],
        search: {
          account: account.account,
          displayName: definition.displayName,
          error: searchError(error),
          id: definition.id,
          isDefaultAccount: account.isDefaultAccount,
          zones: [],
        },
      }),
    ),
  )
}

function providerConnectionDetails() {
  return listProviderStatuses({ verify: false }).pipe(
    Effect.map((providers) =>
      providers.map((provider) => ({
        configured: provider.configured,
        account: provider.account,
        default: provider.default,
        displayName: provider.displayName,
        docsUrl: provider.docsUrl,
        id: provider.id,
        isDefaultAccount: provider.isDefaultAccount,
      })),
    ),
  )
}

function searchWarnings(searches: ProviderZoneSearchResult[]): ProviderSearchWarning[] {
  return searches.flatMap((search) =>
    search.error
      ? [
          {
            account: search.account,
            error: search.error,
            isDefaultAccount: search.isDefaultAccount,
            provider: search.id,
            providerName: search.displayName,
          },
        ]
      : [],
  )
}

function loadConfiguredProviderZones(
  providerId?: string,
  accountInput?: string,
  tolerateProviderAccountErrors = false,
  transportErrorCode: DoomainErrorCode = 'DOMAIN_PROVIDER_DISCOVERY_FAILED',
): DoomainEffect<{
  candidates: ProviderZoneCandidate[]
  accountInferred: boolean
  providerInferred: boolean
  searched: ProviderZoneSearchResult[]
}> {
  return Effect.gen(function* () {
    const config = yield* loadConfig()
    const account = accountInput
      ? yield* trySync(() => normalizeProviderAccount(accountInput), 'INVALID_INPUT')
      : undefined

    if (providerId) {
      const definition = yield* trySync(() => getProviderDefinition(providerId), 'PROVIDER_NOT_FOUND')
      const accounts = account
        ? [explicitAccountRef(definition.id, account)]
        : yield* trySync(() => listConfiguredProviderAccounts(config, definition), 'INVALID_INPUT')
      const selectedAccounts = accounts.length > 0 ? accounts : [defaultAccountRef(definition.id)]
      const tolerateAccountErrors = tolerateProviderAccountErrors && !account && selectedAccounts.length > 1
      const results = yield* Effect.all(
        selectedAccounts.map((ref) =>
          tolerateAccountErrors
            ? loadProviderZonesSafely(definition, ref, transportErrorCode)
            : loadProviderZones(definition, ref, transportErrorCode),
        ),
        { concurrency: 'unbounded' },
      )
      return {
        accountInferred: account === undefined,
        candidates: results.flatMap((result) => result.candidates),
        providerInferred: false,
        searched: results.map((result) => result.search),
      }
    }

    const providerAccounts = yield* trySync(
      () =>
        listProviderDefinitions().flatMap((definition) =>
          listConfiguredProviderAccounts(config, definition)
            .filter((ref) => !account || ref.account === account)
            .map((ref) => ({ definition, ref })),
        ),
      'INVALID_INPUT',
    )

    if (providerAccounts.length === 0) {
      const message = account
        ? `No DNS provider account named ${account} is configured. Run \`doomain providers connect <provider> --account ${account}\` first.`
        : 'No DNS provider is configured. Run `doomain providers connect` first.'
      return yield* Effect.fail(
        new DoomainError('CONFIG_NOT_FOUND', message, {
          account,
          configuredProviders: yield* providerConnectionDetails(),
          recovery: 'Connect the DNS provider that owns this domain, then retry `doomain link <domain> --json`.',
          suggestedCommands: account
            ? [`doomain providers connect <provider> --account ${account}`, 'doomain link <domain> --json']
            : ['doomain providers connect', 'doomain link <domain> --json'],
        }),
      )
    }

    const results = yield* Effect.all(
      providerAccounts.map(({ definition, ref }) =>
        tolerateProviderAccountErrors
          ? loadProviderZonesSafely(definition, ref, transportErrorCode)
          : loadProviderZones(definition, ref, transportErrorCode),
      ),
      { concurrency: 'unbounded' },
    )

    return {
      accountInferred: account === undefined,
      candidates: results.flatMap((result) => result.candidates),
      providerInferred: true,
      searched: results.map((result) => result.search),
    }
  })
}

export function resolveProviderTarget(
  input: ResolveProviderTargetInput,
  options: ResolveProviderTargetOptions = {},
): DoomainEffect<ResolvedDnsTarget> {
  return Effect.gen(function* () {
    const requested = yield* trySync(() => resolveRequestedDomain(input), 'INVALID_INPUT')
    const zones = yield* loadConfiguredProviderZones(
      input.provider,
      input.account,
      options.tolerateProviderAccountErrors,
      options.transportErrorCode,
    )
    const matches = zones.candidates
      .filter((candidate) => zoneMatchesDomain(requested.fullDomain, candidate.zone.name, requested.forceExactZone))
      .sort((a, b) => b.zone.name.length - a.zone.name.length)

    if (matches.length === 0) {
      const account = input.account ? normalizeProviderAccount(input.account) : undefined
      const providerMessage = input.provider
        ? `${getProviderDefinition(input.provider).displayName}${account ? ` account ${account}` : ''} does not have a matching DNS zone for ${requested.fullDomain}.`
        : `No configured DNS provider has a matching DNS zone for ${requested.fullDomain}.`
      return yield* Effect.fail(
        new DoomainError('PROVIDER_ZONE_NOT_FOUND', providerMessage, {
          account,
          configuredProviders: yield* providerConnectionDetails(),
          domain: requested.fullDomain,
          recovery:
            'Retry with --provider <id> --account <alias> only if another configured provider account owns this zone. Otherwise connect the DNS provider account that owns this domain.',
          searchedZones: zones.searched,
          suggestedCommands: [
            `doomain link ${requested.fullDomain} --provider <id> --account <alias> --json`,
            'doomain providers connect',
          ],
        }),
      )
    }

    const bestLength = matches[0].zone.name.length
    const bestMatches = matches.filter((candidate) => candidate.zone.name.length === bestLength)
    const uniqueBestMatches = bestMatches.filter(
      (candidate, index, candidates) =>
        candidates.findIndex(
          (item) =>
            item.provider === candidate.provider &&
            item.account === candidate.account &&
            item.zone.name === candidate.zone.name,
        ) === index,
    )

    if (uniqueBestMatches.length > 1) {
      return yield* Effect.fail(
        new DoomainError(
          'PROVIDER_ZONE_AMBIGUOUS',
          `Multiple DNS provider accounts have a matching DNS zone for ${requested.fullDomain}. Pass --provider and --account to choose one.`,
          { candidates: candidateDetails(uniqueBestMatches), domain: requested.fullDomain },
        ),
      )
    }

    const selected = uniqueBestMatches[0]
    return {
      account: selected.account,
      accountInferred: zones.accountInferred,
      isDefaultAccount: selected.isDefaultAccount,
      provider: selected.provider,
      providerInferred: zones.providerInferred,
      target: targetFromZone(requested.fullDomain, selected.zone.name),
      warnings: searchWarnings(zones.searched),
    }
  })
}

function discoveryError(error: DoomainError, domain: string): DoomainError {
  if (error.code !== 'CONFIG_NOT_FOUND' && error.code !== 'PROVIDER_ZONE_NOT_FOUND') return error

  const details = error.details && typeof error.details === 'object' ? error.details : {}
  return new DoomainError(error.code, error.message, {
    ...details,
    recovery: `Connect or repair the DNS provider account that owns this domain, then retry \`doomain domains find ${domain} --json\`.`,
    suggestedCommands: ['doomain providers connect', `doomain domains find ${domain} --json`],
  })
}

/** Find the configured DNS provider account with the longest zone match for a domain. */
export function findDomainProviderEffect(input: FindDomainProviderInput): DoomainEffect<DomainProviderResult> {
  return resolveProviderTarget(input, { tolerateProviderAccountErrors: true }).pipe(
    Effect.map((resolved) => ({
      account: resolved.account,
      accountInferred: resolved.accountInferred,
      complete: resolved.warnings.length === 0,
      domain: resolved.target.fullDomain,
      isApex: resolved.target.isApex,
      isDefaultAccount: resolved.isDefaultAccount,
      provider: resolved.provider,
      providerInferred: resolved.providerInferred,
      recordName: resolved.target.recordName,
      warnings: resolved.warnings,
      zoneDomain: resolved.target.zoneDomain,
    })),
    Effect.mapError((error) => discoveryError(error, input.domain)),
  )
}

/** Promise facade retained for the package's public programmatic API. */
export function findDomainProvider(input: FindDomainProviderInput): Promise<DomainProviderResult> {
  return runDoomainEffect(findDomainProviderEffect(input))
}
