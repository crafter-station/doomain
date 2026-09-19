import { execFile } from 'node:child_process'
import { getServers } from 'node:dns'
import { networkInterfaces, platform } from 'node:os'
import { promisify } from 'node:util'
import { Effect } from 'effect'

import {
  classifyDnsPropagation,
  type DnsPropagationStatus,
  type DnsResolverObservation,
  isNegativeDnsObservation,
  observeDnsRecord,
} from './dns-propagation.js'
import {
  desiredSlotPostcondition,
  dnsRecordNamesEqual,
  inferAddressRecordType,
  normalizeAddressRecordTarget,
  normalizeDnsValue,
} from './dns-records.js'
import { type ResolvedDnsTarget, resolveProviderTarget } from './domain-provider.js'
import { trySync, type DoomainEffect } from './effect.js'
import { DoomainError } from './errors.js'
import { createProvider } from './providers/registry.js'
import type { DnsProvider, DnsRecord, DnsRecordInput, DnsRecordType } from './providers/types.js'

export type DnsDiagnosisStatus =
  | 'consistent'
  | 'local_or_vpn_cache_stale'
  | 'provider_not_updated'
  | 'public_propagation_pending'
  | 'system_resolver_unavailable'

export interface DiagnoseDnsInput {
  account?: string
  domain: string
  provider?: string
  recordType?: 'A' | 'AAAA' | 'CNAME'
  target?: string
}

export interface DnsRecordConflict {
  reason: 'cname_slot_conflict' | 'multiple_values'
  records: DnsRecord[]
  type?: DnsRecordType
}

export interface MacOsResolverMetadata {
  flags?: string
  interfaceIndex?: number
  interfaceName?: string
  nameservers: string[]
  resolver: number
}

export interface DiagnoseDnsResult {
  account: string
  accountInferred: boolean
  conflicts: DnsRecordConflict[]
  domain: string
  expected?: string
  interfaces: string[]
  isDefaultAccount: boolean
  macOsResolvers?: MacOsResolverMetadata[]
  observations: DnsResolverObservation[]
  platform: NodeJS.Platform
  provider: string
  providerInferred: boolean
  providerRecords: DnsRecord[]
  recordType: 'A' | 'AAAA' | 'CNAME'
  status: DnsDiagnosisStatus
  systemResolverServers: string[]
  warnings: ResolvedDnsTarget['warnings']
  zoneDomain: string
}

interface DiagnoseDnsDependencies {
  createProvider: (provider: string, opts: { account?: string }) => DoomainEffect<DnsProvider>
  observeDns: (
    fqdn: string,
    target: Pick<DnsRecordInput, 'type' | 'value'>,
    elapsedMs: number,
  ) => DoomainEffect<DnsResolverObservation[]>
  resolveTarget: (input: Pick<DiagnoseDnsInput, 'account' | 'domain' | 'provider'>) => DoomainEffect<ResolvedDnsTarget>
  macOsResolvers?: () => DoomainEffect<MacOsResolverMetadata[], never>
}

const execFileAsync = promisify(execFile)

function readMacOsResolvers(): DoomainEffect<MacOsResolverMetadata[], never> {
  if (platform() !== 'darwin') return Effect.succeed([])
  return Effect.tryPromise(() => execFileAsync('scutil', ['--dns'], { maxBuffer: 1024 * 1024 })).pipe(
    Effect.map(({ stdout }) =>
      String(stdout)
        .split(/\n(?=resolver #\d+)/)
        .flatMap((block) => {
          const resolver = block.match(/resolver #(\d+)/)?.[1]
          if (!resolver) return []
          const interfaceMatch = block.match(/if_index\s*:\s*(\d+)(?:\s*\(([^)]+)\))?/)
          const nameservers = [...block.matchAll(/nameserver\[\d+\]\s*:\s*(\S+)/g)].map((match) => match[1])
          const flags = block.match(/flags\s*:\s*(.+)/)?.[1]?.trim()
          return [
            {
              ...(flags ? { flags } : {}),
              ...(interfaceMatch ? { interfaceIndex: Number(interfaceMatch[1]) } : {}),
              ...(interfaceMatch?.[2] ? { interfaceName: interfaceMatch[2] } : {}),
              nameservers,
              resolver: Number(resolver),
            },
          ]
        }),
    ),
    Effect.catchAll(() => Effect.succeed([])),
  )
}

const defaultDependencies: DiagnoseDnsDependencies = {
  createProvider,
  macOsResolvers: readMacOsResolvers,
  observeDns: (fqdn, target, elapsedMs) => observeDnsRecord(fqdn, target, undefined, elapsedMs),
  resolveTarget: (input) => resolveProviderTarget(input, { tolerateProviderAccountErrors: true }),
}

function recordConflicts(records: DnsRecord[]): DnsRecordConflict[] {
  const conflicts: DnsRecordConflict[] = []
  for (const type of ['A', 'AAAA', 'CNAME'] as const) {
    const typed = records.filter((record) => record.type === type)
    const values = new Set(typed.map((record) => normalizeDnsValue(record.value)))
    if (values.size > 1) conflicts.push({ reason: 'multiple_values', records: typed, type })
  }
  const cnames = records.filter((record) => record.type === 'CNAME')
  const otherRecords = records.filter((record) => record.type !== 'CNAME')
  if (cnames.length > 0 && otherRecords.length > 0) {
    conflicts.push({ reason: 'cname_slot_conflict', records: [...cnames, ...otherRecords] })
  }
  return conflicts
}

function activeInterfaceNames(): string[] {
  return Object.entries(networkInterfaces())
    .filter(([, addresses]) => addresses?.some((address) => !address.internal))
    .map(([name]) => name)
    .sort()
}

function diagnosisStatus(status: DnsPropagationStatus): DnsDiagnosisStatus {
  if (status === 'propagated') return 'consistent'
  if (status === 'local_or_vpn_cache_stale') return status
  if (status === 'system_resolver_unavailable') return status
  return 'public_propagation_pending'
}

function diagnosisResolutionError(error: DoomainError, input: DiagnoseDnsInput): DoomainError {
  if (error.code !== 'CONFIG_NOT_FOUND' && error.code !== 'PROVIDER_ZONE_NOT_FOUND') return error
  const details = error.details && typeof error.details === 'object' ? error.details : {}
  const provider = input.provider ? ` --provider ${input.provider}` : ''
  const account = input.account ? ` --account ${input.account}` : ''
  const type = input.recordType ? ` --type ${input.recordType}` : ''
  const target = input.target ? ` --target ${input.target}` : ''
  const retry = `doomain dns diagnose ${input.domain}${provider}${account}${type}${target} --json`
  return new DoomainError(error.code, error.message, {
    ...details,
    recovery: `Connect or repair the DNS provider account that owns this domain, then retry \`${retry}\`.`,
    suggestedCommands: ['doomain providers connect', retry],
  })
}

export function diagnoseDns(
  input: DiagnoseDnsInput,
  dependencies: DiagnoseDnsDependencies = defaultDependencies,
): DoomainEffect<DiagnoseDnsResult> {
  return Effect.gen(function* () {
    const recordType = yield* trySync(
      () => input.recordType ?? (input.target ? inferAddressRecordType(input.target.trim()) : undefined) ?? 'A',
      'INVALID_INPUT',
    )
    const requestedTarget = yield* trySync(
      () => (input.target === undefined ? undefined : normalizeAddressRecordTarget(recordType, input.target)),
      'INVALID_INPUT',
    )
    const resolved = yield* dependencies
      .resolveTarget(input)
      .pipe(Effect.mapError((error) => diagnosisResolutionError(error, input)))
    const provider = yield* dependencies.createProvider(resolved.provider, { account: resolved.account })
    const zone = yield* provider.getZone(resolved.target.zoneDomain)
    if (!zone) {
      return yield* Effect.fail(
        diagnosisResolutionError(
          new DoomainError(
            'PROVIDER_ZONE_NOT_FOUND',
            `${provider.name} does not have a DNS zone for ${resolved.target.zoneDomain}.`,
          ),
          input,
        ),
      )
    }
    const allRecords = yield* provider.listRecords(zone)
    const providerRecords = allRecords.filter((record) => dnsRecordNamesEqual(record.name, resolved.target.recordName))
    const recordsOfType = providerRecords.filter((record) => record.type === recordType)
    const expected = requestedTarget ?? (recordsOfType.length === 1 ? recordsOfType[0].value : undefined)
    const queryTarget = { type: recordType, value: expected ?? recordsOfType[0]?.value ?? '' }
    const observations = yield* dependencies.observeDns(resolved.target.fullDomain, queryTarget, 0)
    const macOsResolvers = dependencies.macOsResolvers ? yield* dependencies.macOsResolvers() : undefined

    let status: DnsDiagnosisStatus
    if (expected) {
      const postcondition = desiredSlotPostcondition(allRecords, {
        name: resolved.target.recordName,
        type: recordType,
        value: expected,
      })
      status = postcondition.reconciled ? diagnosisStatus(classifyDnsPropagation(observations)) : 'provider_not_updated'
    } else {
      const providerValues = new Set(recordsOfType.map((record) => normalizeDnsValue(record.value)))
      const compared = observations.map((observation) => ({
        ...observation,
        matches:
          providerValues.size === 0
            ? observation.answers.length === 0 && isNegativeDnsObservation(observation)
            : observation.answers.length === providerValues.size &&
              observation.answers.every((answer) => providerValues.has(normalizeDnsValue(answer.value))),
      }))
      observations.splice(0, observations.length, ...compared)
      status = diagnosisStatus(classifyDnsPropagation(observations))
    }

    return {
      account: resolved.account,
      accountInferred: resolved.accountInferred,
      conflicts: recordConflicts(providerRecords),
      domain: resolved.target.fullDomain,
      ...(expected === undefined ? {} : { expected }),
      interfaces: activeInterfaceNames(),
      isDefaultAccount: resolved.isDefaultAccount,
      ...(macOsResolvers && macOsResolvers.length > 0 ? { macOsResolvers } : {}),
      observations,
      platform: platform(),
      provider: resolved.provider,
      providerInferred: resolved.providerInferred,
      providerRecords,
      recordType,
      status,
      systemResolverServers: getServers(),
      warnings: resolved.warnings,
      zoneDomain: resolved.target.zoneDomain,
    }
  })
}
