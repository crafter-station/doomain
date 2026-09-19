import { reconcileRecordRemoval } from './dns-reconciliation.js'
import { type DnsRecordSelector, recordMatchesSelector } from './dns-records.js'
import { type ResolvedDnsTarget, resolveProviderTarget } from './domain-provider.js'
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
  createProvider: (provider: string, opts: { account?: string }) => Promise<DnsProvider>
  resolveTarget: (input: Pick<RemoveDomainInput, 'account' | 'domain' | 'provider'>) => Promise<ResolvedDnsTarget>
}

const defaultDependencies: RemoveDomainDependencies = { createProvider, resolveTarget: resolveProviderTarget }

function removalResolutionError(error: DoomainError, input: RemoveDomainInput): DoomainError {
  if (error.code !== 'CONFIG_NOT_FOUND' && error.code !== 'PROVIDER_ZONE_NOT_FOUND') return error
  const details = error.details && typeof error.details === 'object' ? error.details : {}
  const provider = input.provider ? ` --provider ${input.provider}` : ''
  const account = input.account ? ` --account ${input.account}` : ''
  const value = input.value === undefined ? '' : ` --value ${input.value}`
  const allMatching = input.allMatching ? ' --all-matching' : ''
  const dryRun = input.dryRun ? ' --dry-run' : ''
  const retry = `doomain dns remove ${input.domain}${provider}${account} --type ${input.recordType}${value}${allMatching}${dryRun} --json`
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
      suggestedCommands: [
        `doomain dns remove ${input.domain} --type ${input.recordType} --all-matching --dry-run --json`,
      ],
    },
  )
}

export async function removeDomain(
  input: RemoveDomainInput,
  dependencies: RemoveDomainDependencies = defaultDependencies,
): Promise<RemoveDomainResult> {
  if (!input.allMatching && input.value === undefined) {
    throw new DoomainError('INVALID_INPUT', 'An exact --value is required unless --all-matching is passed.', {
      recovery: 'Pass --value <expected-value>, or preview --all-matching with --dry-run.',
    })
  }

  let resolved: ResolvedDnsTarget
  try {
    resolved = await dependencies.resolveTarget(input)
  } catch (error) {
    if (error instanceof DoomainError) throw removalResolutionError(error, input)
    throw error
  }
  const provider = await dependencies.createProvider(resolved.provider, { account: resolved.account })
  if (!provider.capabilities.recordTypes.includes(input.recordType)) {
    throw new DoomainError(
      'PROVIDER_UNSUPPORTED_RECORD',
      `${provider.name} does not support ${input.recordType} records.`,
    )
  }

  const zone = await provider.getZone(resolved.target.zoneDomain)
  if (!zone) {
    throw new DoomainError(
      'PROVIDER_ZONE_NOT_FOUND',
      `${provider.name} does not have a DNS zone for ${resolved.target.zoneDomain}.`,
    )
  }

  const selector = {
    name: resolved.target.recordName,
    type: input.recordType,
    ...(input.value === undefined ? {} : { value: input.value }),
  }
  const existing = await provider.listRecords(zone)
  const matched = existing.filter((record) => recordMatchesSelector(record, selector))

  if (matched.length > 1 && !input.allMatching) {
    const confirmed = (await input.confirmMultiple?.(matched)) === true
    if (!confirmed) throw ambiguousDeletionError(input, matched)
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
  await provider.applyChanges(zone, plan, { force: true })
  const reconciliation = await reconcileRecordRemoval({
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
}
