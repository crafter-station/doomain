import { isIP } from 'node:net'

import { type DnsPropagationResult, type DnsResolverObservation, waitForDnsPropagation } from './dns-propagation.js'
import { reconcileDesiredRecord } from './dns-reconciliation.js'
import { inferAddressRecordType } from './dns-records.js'
import { type ResolvedDnsTarget, resolveProviderTarget } from './domain-provider.js'
import { DoomainError } from './errors.js'
import { type DnsOverrideWarning, withProviderRecordOptions } from './link-domain.js'
import { createProvider } from './providers/registry.js'
import type { DnsProvider, DnsRecordInput } from './providers/types.js'
import { normalizeDomain } from './validate.js'

export type PointRecordType = 'A' | 'AAAA' | 'CNAME'

export interface PointDomainInput {
  account?: string
  domain: string
  dryRun?: boolean
  force?: boolean
  provider?: string
  recordType?: PointRecordType
  target: string
  timeoutSeconds?: number
  ttl?: number
  wait?: boolean
  reconcileTimeoutSeconds?: number
  reconcileSettleSeconds?: number
  confirmDnsOverride?: (warning: DnsOverrideWarning) => Promise<boolean>
  progress?: (message: string) => void
}

export interface PointDomainResult {
  account: string
  accountInferred: boolean
  domain: string
  dryRun: boolean
  isDefaultAccount: boolean
  provider: string
  providerInferred: boolean
  propagated: boolean
  propagation: DnsPropagationResult
  reconciled: boolean
  reconciliationAttempts: number
  record: DnsRecordInput
  skipped: DnsRecordInput[]
  updated: boolean
  zoneDomain: string
}

interface PointDomainDependencies {
  createProvider: (provider: string, opts: { account?: string }) => Promise<DnsProvider>
  observeDns?: (
    fqdn: string,
    target: Pick<DnsRecordInput, 'type' | 'value'>,
    elapsedMs: number,
  ) => Promise<DnsResolverObservation[]>
  resolveTarget: (input: Pick<PointDomainInput, 'account' | 'domain' | 'provider'>) => Promise<ResolvedDnsTarget>
}

const defaultDependencies: PointDomainDependencies = {
  createProvider,
  resolveTarget: resolveProviderTarget,
}

function cleanTarget(value: string): string {
  return value.trim().replace(/\.$/, '')
}

function validateTarget(recordType: PointRecordType, target: string): void {
  const version = isIP(target)
  if (recordType === 'A' && version !== 4) throw new DoomainError('INVALID_INPUT', 'A records require an IPv4 target.')
  if (recordType === 'AAAA' && version !== 6)
    throw new DoomainError('INVALID_INPUT', 'AAAA records require an IPv6 target.')
  if (recordType === 'CNAME' && version !== 0)
    throw new DoomainError('INVALID_INPUT', 'CNAME records require a hostname target.')
}

export function createPointRecord(input: {
  provider: string
  recordName: string
  recordType?: PointRecordType
  target: string
  ttl?: number
}): DnsRecordInput {
  const target = cleanTarget(input.target)
  if (!target) throw new DoomainError('MISSING_ARGUMENT', 'A DNS target is required.')
  const recordType = input.recordType ?? inferAddressRecordType(target)
  validateTarget(recordType, target)
  return withProviderRecordOptions(input.provider, {
    name: input.recordName,
    ttl: input.ttl ?? 300,
    type: recordType,
    value: recordType === 'CNAME' ? normalizeDomain(target) : target,
  })
}

function recordFqdn(record: DnsRecordInput, zoneDomain: string): string {
  return record.name === '@' ? zoneDomain : `${record.name}.${zoneDomain}`
}

function conflictWarning(
  resolved: ResolvedDnsTarget,
  provider: DnsProvider,
  record: DnsRecordInput,
  conflicts: DnsOverrideWarning['conflicts'],
): DnsOverrideWarning {
  return {
    account: resolved.account,
    conflicts,
    desired: [record],
    domain: resolved.target.fullDomain,
    provider: resolved.provider,
    providerName: provider.name,
    recordName: resolved.target.recordName,
    zoneDomain: resolved.target.zoneDomain,
  }
}

function dnsTargetConflictError(warning: DnsOverrideWarning): DoomainError {
  const account = warning.account === 'default' ? '' : ` --account ${warning.account}`
  const target = warning.desired[0]?.value ?? '<ip-or-hostname>'
  return new DoomainError(
    'DNS_TARGET_CONFLICT',
    `${warning.domain} already has DNS records that point somewhere else. Re-run with --force to overwrite them.`,
    {
      ...warning,
      recovery:
        'Re-run with --force to overwrite conflicting DNS records, or confirm the DNS override in interactive mode.',
      suggestedCommands: [
        `doomain dns point ${warning.domain} --target ${target} --provider ${warning.provider}${account} --force --json`,
      ],
    },
  )
}

function providerResolutionError(error: DoomainError, input: PointDomainInput): DoomainError {
  if (error.code !== 'CONFIG_NOT_FOUND' && error.code !== 'PROVIDER_ZONE_NOT_FOUND') return error

  const details = error.details && typeof error.details === 'object' ? error.details : {}
  const provider = input.provider ? ` --provider ${input.provider}` : ''
  const account = input.account ? ` --account ${input.account}` : ''
  const retry = `doomain dns point ${input.domain} --target ${input.target}${provider}${account} --json`
  return new DoomainError(error.code, error.message, {
    ...details,
    recovery: `Connect or repair the DNS provider account that owns this domain, then retry \`${retry}\`.`,
    suggestedCommands: ['doomain providers connect', retry],
  })
}

function validateTtl(provider: DnsProvider, ttl: number | undefined): void {
  if (ttl === undefined) return
  const { maxTtl, minTtl } = provider.capabilities
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new DoomainError('INVALID_INPUT', 'DNS record TTL must be a positive integer.')
  }

  if (minTtl !== undefined && maxTtl !== undefined && (ttl < minTtl || ttl > maxTtl)) {
    throw new DoomainError('INVALID_INPUT', `${provider.name} requires a TTL between ${minTtl} and ${maxTtl} seconds.`)
  }

  if (minTtl !== undefined && ttl < minTtl) {
    throw new DoomainError('INVALID_INPUT', `${provider.name} requires a TTL of at least ${minTtl} seconds.`)
  }

  if (maxTtl !== undefined && ttl > maxTtl) {
    throw new DoomainError('INVALID_INPUT', `${provider.name} requires a TTL no greater than ${maxTtl} seconds.`)
  }
}

export async function pointDomain(
  input: PointDomainInput,
  dependencies: PointDomainDependencies = defaultDependencies,
): Promise<PointDomainResult> {
  let resolved: ResolvedDnsTarget
  try {
    resolved = await dependencies.resolveTarget(input)
  } catch (error) {
    if (error instanceof DoomainError) throw providerResolutionError(error, input)
    throw error
  }

  const record = createPointRecord({
    provider: resolved.provider,
    recordName: resolved.target.recordName,
    recordType: input.recordType,
    target: input.target,
    ttl: input.ttl,
  })
  const provider = await dependencies.createProvider(resolved.provider, { account: resolved.account })
  validateTtl(provider, record.ttl)
  if (!provider.capabilities.recordTypes.includes(record.type)) {
    throw new DoomainError('PROVIDER_UNSUPPORTED_RECORD', `${provider.name} does not support ${record.type} records.`)
  }

  if (resolved.target.isApex && record.type === 'CNAME' && !provider.capabilities.supportsApexCname) {
    throw new DoomainError(
      'PROVIDER_UNSUPPORTED_RECORD',
      `${provider.name} does not support CNAME records at the zone apex. Use an A or AAAA target instead.`,
    )
  }

  if (input.dryRun) {
    return {
      account: resolved.account,
      accountInferred: resolved.accountInferred,
      domain: resolved.target.fullDomain,
      dryRun: true,
      isDefaultAccount: resolved.isDefaultAccount,
      provider: resolved.provider,
      providerInferred: resolved.providerInferred,
      propagated: false,
      propagation: {
        elapsedMs: 0,
        expected: record.value,
        observations: [],
        status: 'not_checked',
      },
      reconciled: false,
      reconciliationAttempts: 0,
      record,
      skipped: [],
      updated: false,
      zoneDomain: resolved.target.zoneDomain,
    }
  }

  const zone = await provider.getZone(resolved.target.zoneDomain)
  if (!zone)
    throw new DoomainError(
      'PROVIDER_ZONE_NOT_FOUND',
      `${provider.name} does not have a DNS zone for ${resolved.target.zoneDomain}.`,
    )

  input.progress?.(`Planning DNS change in ${provider.name}`)
  let force = Boolean(input.force)
  let plan = await provider.planChanges(zone, [record], { force })

  if (!force && plan.conflicts.length > 0) {
    const warning = conflictWarning(resolved, provider, record, plan.conflicts)
    force = (await input.confirmDnsOverride?.(warning)) === true
    if (!force) throw dnsTargetConflictError(warning)
    plan = await provider.planChanges(zone, [record], { force: true })
  }

  input.progress?.(`Pointing ${resolved.target.fullDomain} to ${record.value}`)
  const result = await provider.applyChanges(zone, plan, { force })
  const reconciliation = await reconcileDesiredRecord({
    desired: record,
    force,
    progress: input.progress,
    provider,
    settleMs: (input.reconcileSettleSeconds ?? 5) * 1000,
    timeoutMs: (input.reconcileTimeoutSeconds ?? 30) * 1000,
    zone,
  })
  const shouldWait = input.wait ?? true
  const propagation: DnsPropagationResult = shouldWait
    ? await waitForDnsPropagation({
        fqdn: recordFqdn(record, resolved.target.zoneDomain),
        observe: dependencies.observeDns,
        record,
        timeoutSeconds: input.timeoutSeconds ?? 300,
      })
    : { elapsedMs: 0, expected: record.value, observations: [], status: 'not_checked' }
  const propagated =
    propagation.status === 'propagated' ||
    propagation.status === 'local_or_vpn_cache_stale' ||
    propagation.status === 'system_resolver_unavailable'

  return {
    account: resolved.account,
    accountInferred: resolved.accountInferred,
    domain: resolved.target.fullDomain,
    dryRun: false,
    isDefaultAccount: resolved.isDefaultAccount,
    provider: resolved.provider,
    providerInferred: resolved.providerInferred,
    propagated,
    propagation,
    reconciled: reconciliation.reconciled,
    reconciliationAttempts: reconciliation.attempts,
    record,
    skipped: result.skipped,
    updated: result.applied.length > 0 || reconciliation.appliedChanges > 0,
    zoneDomain: resolved.target.zoneDomain,
  }
}
