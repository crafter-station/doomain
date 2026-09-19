import { Effect } from 'effect'

import { type DoomainEffect, trySync } from '../../effect.js'
import { normalizeDomain } from '../../validate.js'
import { createProviderHttpClient, type ProviderHttpClient } from '../core/http.js'
import { assertNoConflicts, planDnsChanges } from '../core/planner.js'
import type {
  DnsChange,
  DnsChangePlan,
  DnsProvider,
  DnsProviderDefinition,
  DnsRecord,
  DnsRecordInput,
  DnsRecordType,
  DnsZone,
  ProviderCapabilities,
  ProviderContext,
  ProviderHealth,
} from '../types.js'

const HOSTINGER_API_URL = 'https://developers.hostinger.com'

const capabilities: ProviderCapabilities = {
  defaultTtl: 14_400,
  recordTypes: ['A', 'AAAA', 'CNAME', 'MX', 'TXT'],
  supportsApexCname: false,
  supportsBulkWrites: true,
  supportsPagination: false,
  supportsProxying: false,
  supportsRecordIds: false,
}

interface HostingerDomain {
  domain?: string | null
  id?: number
  status?: string
}

interface HostingerNameRecord {
  content?: string
  is_disabled?: boolean
}

interface HostingerZoneRecord {
  name?: string
  records?: HostingerNameRecord[]
  ttl?: number
  type?: string
}

function isSupportedRecordType(type?: string): type is DnsRecordType {
  return capabilities.recordTypes.includes(type as DnsRecordType)
}

function cleanRecordName(name: string, zoneName: string): string {
  const normalized = name.trim().toLowerCase().replace(/\.$/, '')
  const normalizedZone = normalizeDomain(zoneName)
  if (normalized === '@' || normalized === normalizedZone) return '@'
  if (normalized.endsWith(`.${normalizedZone}`)) return normalized.slice(0, -(normalizedZone.length + 1)) || '@'
  return normalized
}

function toZone(domain: HostingerDomain): DnsZone | null {
  if (!domain.domain) return null
  if (domain.status && domain.status !== 'active') return null

  try {
    const name = normalizeDomain(domain.domain)
    return { id: name, metadata: { hostinger: domain }, name }
  } catch {
    return null
  }
}

function toDnsRecords(record: HostingerZoneRecord, zone: DnsZone): DnsRecord[] {
  if (!record.name || !record.type || !isSupportedRecordType(record.type)) return []
  const name = cleanRecordName(record.name, zone.name)
  const type = record.type

  return (record.records ?? []).flatMap((item) => {
    const content = item.content
    if (!content || item.is_disabled) return []

    return [
      {
        metadata: { hostinger: record },
        name,
        ttl: record.ttl,
        type,
        value: content,
      },
    ]
  })
}

function toHostingerRecordSet(records: DnsRecordInput[]): HostingerZoneRecord {
  const first = records[0]
  return {
    name: first.name,
    records: records.map((record) => ({ content: record.value })),
    ttl: first.ttl ?? capabilities.defaultTtl,
    type: first.type,
  }
}

function deleteFilter(record: DnsRecord) {
  return { name: record.name, type: record.type }
}

function sameRecordSet(record: Pick<DnsRecordInput, 'name' | 'type'>, desired: DnsRecordInput): boolean {
  return record.name === desired.name && record.type === desired.type
}

function collapseRecordSetWrites(plan: DnsChangePlan): DnsChangePlan {
  let changes = plan.changes

  for (const desired of plan.desired) {
    const existing = plan.existing.filter((record) => sameRecordSet(record, desired))
    if (existing.length === 0) continue

    const rewritesRecordSet = changes.some(
      (change) =>
        (change.action === 'delete' && sameRecordSet(change.existing, desired)) ||
        (change.action === 'update' && sameRecordSet(change.record, desired)),
    )
    if (!rewritesRecordSet) continue

    changes = changes.filter((change) => {
      if (change.action === 'delete') return !sameRecordSet(change.existing, desired)
      return !sameRecordSet(change.record, desired)
    })
    changes.push({ action: 'update', existing: existing[0], record: desired })
  }

  return { ...plan, changes }
}

export class HostingerProvider implements DnsProvider {
  readonly capabilities = capabilities
  readonly id = 'hostinger'
  readonly name = 'Hostinger'
  private readonly http: ProviderHttpClient

  constructor(context: ProviderContext) {
    this.http = createProviderHttpClient({
      baseUrl: HOSTINGER_API_URL,
      errorMessages: {
        401: 'Hostinger rejected the API token. Re-run `doomain providers connect hostinger` with a valid token.',
        404: 'Hostinger could not find a writable DNS zone for this domain. Make sure the domain is active in Hostinger before linking it.',
        422: 'Hostinger rejected the DNS record payload.',
        429: 'Hostinger rate limit exceeded. Try again later.',
      },
      headers: { Authorization: `Bearer ${context.credentials.apiToken}` },
      providerId: this.id,
      signal: context.signal,
    })
  }

  verifyCredentials(): DoomainEffect<ProviderHealth> {
    return this.listZones().pipe(Effect.as({ ok: true }))
  }

  listZones(): DoomainEffect<DnsZone[]> {
    return this.http.request<HostingerDomain[]>('/api/domains/v1/portfolio').pipe(
      Effect.map((domains) =>
        domains.flatMap((domain) => {
          const zone = toZone(domain)
          return zone ? [zone] : []
        }),
      ),
    )
  }

  getZone(domain: string): DoomainEffect<DnsZone | null> {
    return Effect.gen(this, function* () {
      const normalized = yield* trySync(() => normalizeDomain(domain), 'INVALID_INPUT')
      const zones = yield* this.listZones()
      return zones.find((zone) => zone.name === normalized) ?? null
    })
  }

  listRecords(zone: DnsZone): DoomainEffect<DnsRecord[]> {
    return this.http
      .request<HostingerZoneRecord[]>(`/api/dns/v1/zones/${encodeURIComponent(zone.name)}`)
      .pipe(Effect.map((records) => records.flatMap((record) => toDnsRecords(record, zone))))
  }

  planChanges(zone: DnsZone, desired: DnsRecordInput[], opts: { force?: boolean } = {}): DoomainEffect<DnsChangePlan> {
    return this.listRecords(zone).pipe(
      Effect.map((existing) =>
        collapseRecordSetWrites(planDnsChanges({ desired, existing, force: opts.force, providerId: this.id, zone })),
      ),
    )
  }

  applyChanges(zone: DnsZone, plan: DnsChangePlan): DoomainEffect<{ applied: DnsChange[]; skipped: DnsRecordInput[] }> {
    return Effect.gen(this, function* () {
      yield* assertNoConflicts(this.id, plan)
      const applied: DnsChange[] = []
      const skipped: DnsRecordInput[] = []

      const deletionSets = new Map<string, Extract<DnsChange, { action: 'delete' }>['existing'][]>()
      for (const change of plan.changes) {
        if (change.action !== 'delete') continue
        const key = `${change.existing.type}\0${change.existing.name}`
        const records = deletionSets.get(key) ?? []
        records.push(change.existing)
        deletionSets.set(key, records)
      }

      for (const deleted of deletionSets.values()) {
        const sample = deleted[0]
        const source = sample.metadata?.hostinger as HostingerZoneRecord | undefined
        const deletedValues = new Set(deleted.map((record) => record.value))
        const sourceRecords = source?.records?.filter(
          (record) => record.is_disabled || !record.content || !deletedValues.has(record.content),
        )
        if (source && sourceRecords && sourceRecords.length > 0) {
          yield* this.putHostingerRecordSets(zone, [{ ...source, records: sourceRecords }], true)
        } else {
          const remaining = plan.existing.filter((record) => sameRecordSet(record, sample) && !deleted.includes(record))
          if (remaining.length > 0) yield* this.putRecords(zone, remaining, true)
          else yield* this.deleteRecord(zone, sample)
        }
        applied.push(
          ...plan.changes.filter((change) => change.action === 'delete' && deleted.includes(change.existing)),
        )
      }

      for (const change of plan.changes) {
        if (change.action === 'skip') {
          skipped.push(change.record)
          continue
        }

        if (change.action === 'delete') continue
        yield* this.putRecords(zone, [change.record], change.action === 'update')

        applied.push(change)
      }

      return { applied, skipped }
    })
  }

  upsertRecord(zone: DnsZone, record: DnsRecordInput): DoomainEffect<DnsRecord> {
    return this.putRecords(zone, [record], true).pipe(
      Effect.as({ ...record, ttl: record.ttl ?? capabilities.defaultTtl }),
    )
  }

  deleteRecord(zone: DnsZone, record: DnsRecord): DoomainEffect<void> {
    return this.http
      .request(`/api/dns/v1/zones/${encodeURIComponent(zone.name)}`, {
        body: { filters: [deleteFilter(record)] },
        method: 'DELETE',
      })
      .pipe(Effect.asVoid)
  }

  private putRecords(zone: DnsZone, records: DnsRecordInput[], overwrite: boolean): DoomainEffect<void> {
    const recordSets = new Map<string, DnsRecordInput[]>()
    for (const record of records) {
      const key = `${record.type}\0${record.name}`
      const values = recordSets.get(key) ?? []
      values.push(record)
      recordSets.set(key, values)
    }
    return this.putHostingerRecordSets(zone, [...recordSets.values()].map(toHostingerRecordSet), overwrite)
  }

  private putHostingerRecordSets(
    zone: DnsZone,
    recordSets: HostingerZoneRecord[],
    overwrite: boolean,
  ): DoomainEffect<void> {
    return this.http
      .request(`/api/dns/v1/zones/${encodeURIComponent(zone.name)}`, {
        body: { overwrite, zone: recordSets },
        method: 'PUT',
      })
      .pipe(Effect.asVoid)
  }
}

export const hostingerProviderDefinition: DnsProviderDefinition = {
  capabilities,
  credentials: [{ env: 'HOSTINGER_API_TOKEN', key: 'apiToken', label: 'API token', required: true, secret: true }],
  displayName: 'Hostinger',
  docsUrl: 'https://developers.hostinger.com/',
  id: 'hostinger',
  name: 'Hostinger',
  setup: {
    notes: [
      'Create a Hostinger API token from hPanel Account > API with access to the domains you want Doomain to manage.',
      'Doomain uses the Hostinger domain portfolio API to infer zones and the DNS zone API to update records.',
    ],
  },
  create(context) {
    return new HostingerProvider(context)
  },
}
