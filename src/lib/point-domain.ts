import { Effect } from 'effect'

import { type DnsPropagationResult, type DnsResolverObservation, waitForDnsPropagation } from './dns-propagation.js'
import { reconcileDesiredRecord } from './dns-reconciliation.js'
import { inferAddressRecordType, normalizeAddressRecordTarget } from './dns-records.js'
import { type ResolvedDnsTarget, resolveProviderTarget } from './domain-provider.js'
import { type DoomainEffect, trySync } from './effect.js'
import { DoomainError } from './errors.js'
import { type DnsOverrideWarning, withProviderRecordOptions } from './link-domain.js'
import { createProvider } from './providers/registry.js'
import type { DnsProvider, DnsRecordInput } from './providers/types.js'

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
  createProvider: (provider: string, opts: { account?: string }) => DoomainEffect<DnsProvider>
  observeDns?: (
    fqdn: string,
    target: Pick<DnsRecordInput, 'type' | 'value'>,
    elapsedMs: number,
  ) => DoomainEffect<DnsResolverObservation[]>
  resolveTarget: (input: Pick<PointDomainInput, 'account' | 'domain' | 'provider'>) => DoomainEffect<ResolvedDnsTarget>
}

const defaultDependencies: PointDomainDependencies = {
  createProvider,
  resolveTarget: resolveProviderTarget,
}

export function createPointRecord(input: {
  provider: string
  recordName: string
  recordType?: PointRecordType
  target: string
  ttl?: number
}): DnsRecordInput {
  const recordType = input.recordType ?? inferAddressRecordType(input.target.trim())
  const target = normalizeAddressRecordTarget(recordType, input.target)
  return withProviderRecordOptions(input.provider, {
    name: input.recordName,
    ttl: input.ttl ?? 300,
    type: recordType,
    value: target,
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
  if (error.code === 'PROVIDER_API_ERROR' && error.details instanceof Error) {
    return new DoomainError('DNS_POINT_FAILED', error.details.message)
  }
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

export function pointDomain(
  input: PointDomainInput,
  dependencies: PointDomainDependencies = defaultDependencies,
): DoomainEffect<PointDomainResult> {
  return Effect.gen(function* () {
    const resolved = yield* dependencies
      .resolveTarget(input)
      .pipe(Effect.mapError((error) => providerResolutionError(error, input)))

    const record = yield* trySync(
      () =>
        createPointRecord({
          provider: resolved.provider,
          recordName: resolved.target.recordName,
          recordType: input.recordType,
          target: input.target,
          ttl: input.ttl,
        }),
      'INVALID_INPUT',
    )
    const provider = yield* dependencies.createProvider(resolved.provider, { account: resolved.account })
    yield* trySync(() => validateTtl(provider, record.ttl), 'INVALID_INPUT')
    if (!provider.capabilities.recordTypes.includes(record.type)) {
      return yield* Effect.fail(
        new DoomainError('PROVIDER_UNSUPPORTED_RECORD', `${provider.name} does not support ${record.type} records.`),
      )
    }

    if (resolved.target.isApex && record.type === 'CNAME' && !provider.capabilities.supportsApexCname) {
      return yield* Effect.fail(
        new DoomainError(
          'PROVIDER_UNSUPPORTED_RECORD',
          `${provider.name} does not support CNAME records at the zone apex. Use an A or AAAA target instead.`,
        ),
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
        propagation: { elapsedMs: 0, expected: record.value, observations: [], status: 'not_checked' },
        reconciled: false,
        reconciliationAttempts: 0,
        record,
        skipped: [],
        updated: false,
        zoneDomain: resolved.target.zoneDomain,
      }
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

    input.progress?.(`Planning DNS change in ${provider.name}`)
    let force = Boolean(input.force)
    let plan = yield* provider.planChanges(zone, [record], { force })

    if (!force && plan.conflicts.length > 0) {
      const warning = conflictWarning(resolved, provider, record, plan.conflicts)
      force = input.confirmDnsOverride
        ? yield* Effect.promise(() => input.confirmDnsOverride?.(warning) ?? Promise.resolve(false))
        : false
      if (!force) return yield* Effect.fail(dnsTargetConflictError(warning))
      plan = yield* provider.planChanges(zone, [record], { force: true })
    }

    input.progress?.(`Pointing ${resolved.target.fullDomain} to ${record.value}`)
    const result = yield* provider.applyChanges(zone, plan, { force })
    const reconciliation = yield* reconcileDesiredRecord({
      desired: record,
      progress: input.progress,
      provider,
      timeoutMs: (input.reconcileTimeoutSeconds ?? 30) * 1000,
      zone,
    })
    const shouldWait = input.wait ?? true
    const propagation: DnsPropagationResult = shouldWait
      ? yield* waitForDnsPropagation({
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
  })
}
