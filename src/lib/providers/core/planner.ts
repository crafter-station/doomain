import {ProviderError} from './errors.js'
import type {DnsChange, DnsChangePlan, DnsConflict, DnsRecord, DnsRecordInput, DnsZone, PlanOptions} from './types.js'

function cleanDnsValue(value: string): string {
  return value.toLowerCase().replace(/\.$/, '')
}

function sameRecord(a: DnsRecord | DnsRecordInput, b: DnsRecord | DnsRecordInput): boolean {
  if (b.proxied !== undefined && a.proxied !== b.proxied) return false
  return a.type === b.type && a.name === b.name && cleanDnsValue(a.value) === cleanDnsValue(b.value)
}

function sameDnsValue(a: DnsRecord | DnsRecordInput, b: DnsRecord | DnsRecordInput): boolean {
  return a.type === b.type && a.name === b.name && cleanDnsValue(a.value) === cleanDnsValue(b.value)
}

function sameSlot(a: DnsRecord | DnsRecordInput, b: DnsRecord | DnsRecordInput): boolean {
  return a.type === b.type && a.name === b.name
}

function cnameSlotConflict(a: DnsRecord | DnsRecordInput, b: DnsRecord | DnsRecordInput): boolean {
  return a.name === b.name && (a.type === 'CNAME' || b.type === 'CNAME')
}

export function planDnsChanges(input: {
  desired: DnsRecordInput[]
  existing: DnsRecord[]
  force?: boolean
  providerId: string
  zone: DnsZone
}): DnsChangePlan {
  const changes: DnsChange[] = []
  const conflicts: DnsConflict[] = []

  for (const record of input.desired) {
    const exact = input.existing.find((existing) => sameRecord(existing, record))
    const sameValue = input.existing.find((existing) => sameDnsValue(existing, record))

    if (record.type === 'TXT') {
      changes.push(exact ? {action: 'skip', existing: exact, reason: 'already_exists', record} : {action: 'create', record})
      continue
    }

    const sameTyped = input.existing.filter((existing) => sameSlot(existing, record) && !sameDnsValue(existing, record))
    const cnameConflicts = input.existing.filter((existing) => cnameSlotConflict(existing, record) && !sameSlot(existing, record))

    if (!input.force && (sameTyped.length > 0 || cnameConflicts.length > 0)) {
      conflicts.push(
        ...sameTyped.map((existing) => ({existing, reason: 'same_type_record_exists', record})),
        ...cnameConflicts.map((existing) => ({existing, reason: 'cname_slot_conflict', record})),
      )
      continue
    }

    if (exact) {
      changes.push(
        ...sameTyped.map((existing) => ({action: 'delete' as const, existing, reason: 'same_type_record_exists'})),
        ...cnameConflicts.map((existing) => ({action: 'delete' as const, existing, reason: 'cname_slot_conflict'})),
        {action: 'skip', existing: exact, reason: 'already_exists', record},
      )
      continue
    }

    if (sameValue && record.proxied !== undefined && sameValue.proxied !== record.proxied) {
      changes.push(
        ...sameTyped.map((existing) => ({action: 'delete' as const, existing, reason: 'same_type_record_exists'})),
        ...cnameConflicts.map((existing) => ({action: 'delete' as const, existing, reason: 'cname_slot_conflict'})),
        {action: 'update', existing: sameValue, record},
      )
      continue
    }

    const [replace, ...remainingSameTyped] = sameTyped
    changes.push(
      ...(replace ? [{action: 'update' as const, existing: replace, record}] : []),
      ...remainingSameTyped.map((existing) => ({action: 'delete' as const, existing, reason: 'same_type_record_exists'})),
      ...cnameConflicts.map((existing) => ({action: 'delete' as const, existing, reason: 'cname_slot_conflict'})),
      ...(replace ? [] : [{action: 'create' as const, record}]),
    )
  }

  return {changes, conflicts, desired: input.desired, existing: input.existing, zone: input.zone}
}

export function assertNoConflicts(providerId: string, plan: DnsChangePlan): void {
  if (plan.conflicts.length === 0) return
  throw new ProviderError(providerId, 'PROVIDER_RECORD_CONFLICT', 'DNS record conflicts must be resolved before applying changes.', {
    conflicts: plan.conflicts,
  })
}

export async function applyDnsChanges(input: {
  deleteRecord(record: DnsRecord): Promise<void>
  plan: DnsChangePlan
  providerId: string
  upsertRecord(record: DnsRecordInput): Promise<DnsRecord>
  opts?: PlanOptions
}) {
  assertNoConflicts(input.providerId, input.plan)
  const applied: DnsChange[] = []
  const skipped: DnsRecordInput[] = []

  for (const change of input.plan.changes) {
    if (change.action === 'skip') {
      skipped.push(change.record)
      continue
    }

    await (change.action === 'delete' ? input.deleteRecord(change.existing) : input.upsertRecord(change.record))

    applied.push(change)
  }

  return {applied, skipped}
}
