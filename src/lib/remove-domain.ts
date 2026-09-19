import { Effect } from 'effect'

import { reconcileRecordRemoval } from './dns-reconciliation.js'
import { type DnsRecordSelector, recordMatchesSelector } from './dns-records.js'
import { type ResolvedDnsTarget, resolveProviderTarget } from './domain-provider.js'
import type { DoomainEffect } from './effect.js'
import { DoomainError } from './errors.js'
import { createProvider } from './providers/registry.js'
import type { DnsChangePlan, DnsProvider, DnsRecord, DnsRecordType } from './providers/types.js'

export interface RemoveDomainInput {
  account?: string
  allMatching?: boolean
  domain: string
  dryRun?: boolean
  provider?: string
  recordType: DnsRecordType
  reconcileTimeoutSeconds?: number
  value?: string
  confirmMultiple?: (records: DnsRecord[]) => Promise<boolean>
  progress?: (message: string) => void
}

export interface RemoveDomainResult {
  account: string
  accountInferred: boolean
  domain: string
  dryRun: boolean
  isDefaultAccount: boolean
  matched: DnsRecord[]
  provider: string
  providerInferred: boolean
  reconciled: boolean
  reconciliationAttempts: number
  removed: number
  selector: DnsRecordSelector
  zoneDomain: string
}

interface RemoveDomainDependencies {
  createProvider: (provider: string, opts: { account?: string }) => DoomainEffect<DnsProvider>
  resolveTarget: (input: Pick<RemoveDomainInput, 'account' | 'domain' | 'provider'>) => DoomainEffect<ResolvedDnsTarget>
}

const defaultDependencies: RemoveDomainDependencies = { createProvider, resolveTarget: resolveProviderTarget }

function quoteCommandArgument(value: string): string {
  return /^[a-zA-Z0-9_./:@+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`
}

function removalCommand(input: RemoveDomainInput, options?: { allMatching?: boolean; dryRun?: boolean }): string {
  const arguments_ = ['doomain', 'dns', 'remove', quoteCommandArgument(input.domain)]
  if (input.provider) arguments_.push('--provider', quoteCommandArgument(input.provider))
  if (input.account) arguments_.push('--account', quoteCommandArgument(input.account))
  arguments_.push('--type', input.recordType)
  if (input.value !== undefined) arguments_.push('--value', quoteCommandArgument(input.value))
  if (options?.allMatching ?? input.allMatching) arguments_.push('--all-matching')
  if (options?.dryRun ?? input.dryRun) arguments_.push('--dry-run')
  arguments_.push('--json')
  return arguments_.join(' ')
}

function removalResolutionError(error: DoomainError, input: RemoveDomainInput): DoomainError {
  if (error.code !== 'CONFIG_NOT_FOUND' && error.code !== 'PROVIDER_ZONE_NOT_FOUND') return error
  const details = error.details && typeof error.details === 'object' ? error.details : {}
  const retry = removalCommand(input)
  return new DoomainError(error.code, error.message, {
    ...details,
    recovery: `Connect or repair the DNS provider account that owns this domain, then retry \`${retry}\`.`,
    suggestedCommands: ['doomain providers connect', retry],
  })
}

function ambiguousDeletionError(input: RemoveDomainInput, records: DnsRecord[]): DoomainError {
  return new DoomainError(
    'DNS_DELETE_AMBIGUOUS',
    `${records.length} DNS records match this deletion. Pass --all-matching to delete all of them.`,
    {
      matched: records,
      recovery: 'Narrow the deletion with --value, or explicitly approve all matching records with --all-matching.',
      suggestedCommands: [removalCommand(input, { allMatching: true, dryRun: true })],
    },
  )
}

export function removeDomain(
  input: RemoveDomainInput,
  dependencies: RemoveDomainDependencies = defaultDependencies,
): DoomainEffect<RemoveDomainResult> {
  return Effect.gen(function* () {
    if (!input.allMatching && input.value === undefined) {
      return yield* Effect.fail(
        new DoomainError('INVALID_INPUT', 'An exact --value is required unless --all-matching is passed.', {
          recovery: 'Pass --value <expected-value>, or preview --all-matching with --dry-run.',
        }),
      )
    }

    const resolved = yield* dependencies
      .resolveTarget(input)
      .pipe(Effect.mapError((error) => removalResolutionError(error, input)))
    const provider = yield* dependencies.createProvider(resolved.provider, { account: resolved.account })
    if (!provider.capabilities.recordTypes.includes(input.recordType)) {
      return yield* Effect.fail(
        new DoomainError(
          'PROVIDER_UNSUPPORTED_RECORD',
          `${provider.name} does not support ${input.recordType} records.`,
        ),
      )
    }

    const zone = yield* provider.getZone(resolved.target.zoneDomain)
    if (!zone) {
      return yield* Effect.fail(
        new DoomainError(
          'PROVIDER_ZONE_NOT_FOUND',
          `${provider.name} does not have a DNS zone for ${resolved.target.zoneDomain}.`,
        ),
      )
    }

    const selector = {
      name: resolved.target.recordName,
      type: input.recordType,
      ...(input.value === undefined ? {} : { value: input.value }),
    }
    const existing = yield* provider.listRecords(zone)
    const matched = existing.filter((record) => recordMatchesSelector(record, selector))

    if (matched.length > 1 && !input.allMatching) {
      const confirmed = input.confirmMultiple
        ? yield* Effect.promise(() => input.confirmMultiple?.(matched) ?? Promise.resolve(false))
        : false
      if (!confirmed) return yield* Effect.fail(ambiguousDeletionError(input, matched))
    }

    const base = {
      account: resolved.account,
      accountInferred: resolved.accountInferred,
      domain: resolved.target.fullDomain,
      isDefaultAccount: resolved.isDefaultAccount,
      matched,
      provider: resolved.provider,
      providerInferred: resolved.providerInferred,
      selector,
      zoneDomain: resolved.target.zoneDomain,
    }

    if (input.dryRun) {
      return {
        ...base,
        dryRun: true,
        reconciled: false,
        reconciliationAttempts: 0,
        removed: 0,
      }
    }

    if (matched.length === 0) {
      return { ...base, dryRun: false, reconciled: true, reconciliationAttempts: 1, removed: 0 }
    }

    input.progress?.(`Deleting ${matched.length} DNS record${matched.length === 1 ? '' : 's'}`)
    const plan: DnsChangePlan = {
      changes: matched.map((record) => ({ action: 'delete', existing: record })),
      conflicts: [],
      desired: [],
      existing,
      zone,
    }
    yield* provider.applyChanges(zone, plan, { force: true })
    const reconciliation = yield* reconcileRecordRemoval({
      progress: input.progress,
      provider,
      selector,
      timeoutMs: (input.reconcileTimeoutSeconds ?? 30) * 1000,
      zone,
    })

    return {
      ...base,
      dryRun: false,
      reconciled: reconciliation.reconciled,
      reconciliationAttempts: reconciliation.attempts,
      removed: matched.length,
    }
  })
}
