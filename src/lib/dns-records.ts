import { isIP } from 'node:net'

import { DoomainError } from './errors.js'
import type { DnsRecord, DnsRecordInput } from './providers/types.js'
import { normalizeDomain } from './validate.js'

export interface DnsRecordSelector {
  name: string
  type: DnsRecord['type']
  value?: string
}

function normalizeIpv6(value: string): string {
  try {
    return new URL(`http://[${value}]`).hostname.slice(1, -1)
  } catch {
    return value.toLowerCase()
  }
}

export function normalizeDnsValue(value: string): string {
  const cleaned = value.trim().toLowerCase().replace(/\.$/, '')
  return isIP(cleaned) === 6 ? normalizeIpv6(cleaned) : cleaned
}

export function inferAddressRecordType(target: string): 'A' | 'AAAA' | 'CNAME' {
  const version = isIP(target)
  if (version === 4) return 'A'
  if (version === 6) return 'AAAA'
  return 'CNAME'
}

export function normalizeAddressRecordTarget(recordType: 'A' | 'AAAA' | 'CNAME', value: string): string {
  const target = value.trim().replace(/\.$/, '')
  if (!target) throw new DoomainError('MISSING_ARGUMENT', 'A DNS target is required.')
  const version = isIP(target)
  if (recordType === 'A' && version !== 4) throw new DoomainError('INVALID_INPUT', 'A records require an IPv4 target.')
  if (recordType === 'AAAA' && version !== 6)
    throw new DoomainError('INVALID_INPUT', 'AAAA records require an IPv6 target.')
  if (recordType === 'CNAME' && version !== 0)
    throw new DoomainError('INVALID_INPUT', 'CNAME records require a hostname target.')
  return recordType === 'CNAME' ? normalizeDomain(target) : target
}

export function dnsRecordNamesEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase().replace(/\.$/, '') === b.trim().toLowerCase().replace(/\.$/, '')
}

function comparableRecordValue(type: DnsRecord['type'], value: string): string {
  return type === 'TXT' ? value : normalizeDnsValue(value)
}

export function sameDnsRecordTarget(a: DnsRecord | DnsRecordInput, b: DnsRecord | DnsRecordInput): boolean {
  return (
    dnsRecordNamesEqual(a.name, b.name) &&
    a.type === b.type &&
    comparableRecordValue(a.type, a.value) === comparableRecordValue(b.type, b.value)
  )
}

export function sameDnsRecordValue(a: DnsRecord | DnsRecordInput, b: DnsRecord | DnsRecordInput): boolean {
  return (
    sameDnsRecordTarget(a, b) &&
    (b.ttl === undefined || a.ttl === b.ttl) &&
    (b.priority === undefined || a.priority === b.priority) &&
    (b.proxied === undefined || a.proxied === b.proxied)
  )
}

export function recordsInNonTxtSlot(records: DnsRecord[], desired: DnsRecordInput): DnsRecord[] {
  if (desired.type === 'TXT')
    return records.filter((record) => dnsRecordNamesEqual(record.name, desired.name) && record.type === 'TXT')

  return records.filter(
    (record) =>
      dnsRecordNamesEqual(record.name, desired.name) &&
      record.type !== 'TXT' &&
      (record.type === desired.type || record.type === 'CNAME' || desired.type === 'CNAME'),
  )
}

export function desiredSlotPostcondition(
  records: DnsRecord[],
  desired: DnsRecordInput,
): { observed: DnsRecord[]; reconciled: boolean } {
  const observed = recordsInNonTxtSlot(records, desired)
  return {
    observed,
    reconciled: observed.length === 1 && sameDnsRecordValue(observed[0], desired),
  }
}

export function recordMatchesSelector(record: DnsRecord, selector: DnsRecordSelector): boolean {
  return (
    dnsRecordNamesEqual(record.name, selector.name) &&
    record.type === selector.type &&
    (selector.value === undefined ||
      comparableRecordValue(record.type, record.value) === comparableRecordValue(selector.type, selector.value))
  )
}
