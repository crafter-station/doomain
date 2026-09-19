import { execFile } from 'node:child_process'
import { getServers } from 'node:dns'
import { networkInterfaces, platform } from 'node:os'
import { promisify } from 'node:util'

import {
  classifyDnsPropagation,
  type DnsPropagationStatus,
  type DnsResolverObservation,
  observeDnsRecord,
} from './dns-propagation.js'
import { desiredSlotPostcondition, inferAddressRecordType, normalizeDnsValue } from './dns-records.js'
import { type ResolvedDnsTarget, resolveProviderTarget } from './domain-provider.js'
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
  createProvider: (provider: string, opts: { account?: string }) => Promise<DnsProvider>
  observeDns: (
    fqdn: string,
    target: Pick<DnsRecordInput, 'type' | 'value'>,
    elapsedMs: number,
  ) => Promise<DnsResolverObservation[]>
  resolveTarget: (input: Pick<DiagnoseDnsInput, 'account' | 'domain' | 'provider'>) => Promise<ResolvedDnsTarget>
  macOsResolvers?: () => Promise<MacOsResolverMetadata[]>
}

const execFileAsync = promisify(execFile)

async function readMacOsResolvers(): Promise<MacOsResolverMetadata[]> {
  if (platform() !== 'darwin') return []
  try {
    const { stdout } = await execFileAsync('scutil', ['--dns'], { maxBuffer: 1024 * 1024 })
    return String(stdout)
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
      })
  } catch {
    return []
  }
}

const defaultDependencies: DiagnoseDnsDependencies = {
  createProvider,
  macOsResolvers: readMacOsResolvers,
  observeDns: (fqdn, target, elapsedMs) => observeDnsRecord(fqdn, target, undefined, elapsedMs),
  resolveTarget: resolveProviderTarget,
}

function recordConflicts(records: DnsRecord[]): DnsRecordConflict[] {
  const addressRecords = records.filter((record) => ['A', 'AAAA', 'CNAME'].includes(record.type))
  const conflicts: DnsRecordConflict[] = []
  for (const type of ['A', 'AAAA', 'CNAME'] as const) {
    const typed = addressRecords.filter((record) => record.type === type)
    const values = new Set(typed.map((record) => normalizeDnsValue(record.value)))
    if (values.size > 1) conflicts.push({ reason: 'multiple_values', records: typed, type })
  }
  const cnames = addressRecords.filter((record) => record.type === 'CNAME')
  const addresses = addressRecords.filter((record) => record.type === 'A' || record.type === 'AAAA')
  if (cnames.length > 0 && addresses.length > 0) {
    conflicts.push({ reason: 'cname_slot_conflict', records: [...cnames, ...addresses] })
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

export async function diagnoseDns(
  input: DiagnoseDnsInput,
  dependencies: DiagnoseDnsDependencies = defaultDependencies,
): Promise<DiagnoseDnsResult> {
  const resolved = await dependencies.resolveTarget(input)
  const provider = await dependencies.createProvider(resolved.provider, { account: resolved.account })
  const zone = await provider.getZone(resolved.target.zoneDomain)
  const allRecords = zone ? await provider.listRecords(zone) : []
  const providerRecords = allRecords.filter((record) => record.name === resolved.target.recordName)
  const recordType = input.recordType ?? (input.target ? inferAddressRecordType(input.target) : undefined) ?? 'A'
  const recordsOfType = providerRecords.filter((record) => record.type === recordType)
  const expected = input.target ?? (recordsOfType.length === 1 ? recordsOfType[0].value : undefined)
  const queryTarget = { type: recordType, value: expected ?? recordsOfType[0]?.value ?? '' }
  const observations = await dependencies.observeDns(resolved.target.fullDomain, queryTarget, 0)
  const macOsResolvers = await dependencies.macOsResolvers?.()

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
        providerValues.size > 0 &&
        observation.answers.length === providerValues.size &&
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
}
