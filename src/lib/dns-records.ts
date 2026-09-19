import { isIP } from 'node:net'

import type { DnsRecord, DnsRecordInput } from './providers/types.js'

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

function comparableRecordValue(type: DnsRecord['type'], value: string): string {
  return type === 'TXT' ? value : normalizeDnsValue(value)
}

export function sameDnsRecordValue(a: DnsRecord | DnsRecordInput, b: DnsRecord | DnsRecordInput): boolean {
  return (
    a.name === b.name &&
    a.type === b.type &&
    comparableRecordValue(a.type, a.value) === comparableRecordValue(b.type, b.value)
  )
}

export function recordsInNonTxtSlot(records: DnsRecord[], desired: DnsRecordInput): DnsRecord[] {
  if (desired.type === 'TXT') return records.filter((record) => record.name === desired.name && record.type === 'TXT')

  return records.filter(
    (record) =>
      record.name === desired.name &&
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
    record.name === selector.name &&
    record.type === selector.type &&
    (selector.value === undefined ||
      comparableRecordValue(record.type, record.value) === comparableRecordValue(selector.type, selector.value))
  )
}
