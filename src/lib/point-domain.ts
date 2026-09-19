import { resolve4, resolve6, resolveCname } from 'node:dns/promises'
import { isIP } from 'node:net'

import { resolveProviderTarget, type ResolvedDnsTarget } from './domain-provider.js'
import { DoomainError } from './errors.js'
import { withProviderRecordOptions, type DnsOverrideWarning } from './link-domain.js'
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
  record: DnsRecordInput
  skipped: DnsRecordInput[]
  updated: boolean
  zoneDomain: string
}

interface PointDomainDependencies {
  createProvider: (provider: string, opts: { account?: string }) => Promise<DnsProvider>
  resolve4?: (hostname: string) => Promise<string[]>
  resolve6?: (hostname: string) => Promise<string[]>
  resolveCname?: (hostname: string) => Promise<string[]>
  resolveTarget: (input: Pick<PointDomainInput, 'account' | 'domain' | 'provider'>) => Promise<ResolvedDnsTarget>
}

const defaultDependencies: PointDomainDependencies = {
  createProvider,
  resolveTarget: resolveProviderTarget,
}

function cleanTarget(value: string): string {
  return value.trim().replace(/\.$/, '')
}

function inferredRecordType(target: string): PointRecordType {
  const version = isIP(target)
  if (version === 4) return 'A'
  if (version === 6) return 'AAAA'
  return 'CNAME'
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
  const recordType = input.recordType ?? inferredRecordType(target)
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

function cleanDnsValue(value: string): string {
  return value.toLowerCase().replace(/\.$/, '')
}

function normalizeIpv6(value: string): string {
  return new URL(`http://[${value}]`).hostname.slice(1, -1)
}

async function isPropagated(
  record: DnsRecordInput,
  zoneDomain: string,
  dependencies: PointDomainDependencies,
): Promise<boolean> {
  const fqdn = recordFqdn(record, zoneDomain)
  try {
    if (record.type === 'A') return (await (dependencies.resolve4 ?? resolve4)(fqdn)).includes(record.value)
    if (record.type === 'AAAA') {
      const expected = normalizeIpv6(record.value)
      return (await (dependencies.resolve6 ?? resolve6)(fqdn)).some((value) => normalizeIpv6(value) === expected)
    }

    if (record.type === 'CNAME') {
      return (await (dependencies.resolveCname ?? resolveCname)(fqdn))
        .map(cleanDnsValue)
        .includes(cleanDnsValue(record.value))
    }
  } catch {
    return false
  }
  return false
}

async function waitForPropagation(
  record: DnsRecordInput,
  zoneDomain: string,
  timeoutSeconds: number,
  dependencies: PointDomainDependencies,
): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000
  while (true) {
    if (await isPropagated(record, zoneDomain, dependencies)) return true
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await new Promise((resolve) => setTimeout(resolve, Math.min(5000, remaining)))
  }
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
  const shouldWait = input.wait ?? true
  const propagated = shouldWait
    ? await waitForPropagation(record, resolved.target.zoneDomain, input.timeoutSeconds ?? 300, dependencies)
    : false

  return {
    account: resolved.account,
    accountInferred: resolved.accountInferred,
    domain: resolved.target.fullDomain,
    dryRun: false,
    isDefaultAccount: resolved.isDefaultAccount,
    provider: resolved.provider,
    providerInferred: resolved.providerInferred,
    propagated,
    record,
    skipped: result.skipped,
    updated: result.applied.length > 0,
    zoneDomain: resolved.target.zoneDomain,
  }
}
