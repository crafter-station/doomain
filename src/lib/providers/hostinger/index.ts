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
        metadata: { hostinger: { ...record, records: [item] } },
        name,
        ttl: record.ttl,
        type,
        value: content,
      },
    ]
  })
}

function toHostingerRecord(record: DnsRecordInput): HostingerZoneRecord {
  return {
    name: record.name,
    records: [{ content: record.value }],
    ttl: record.ttl ?? capabilities.defaultTtl,
    type: record.type,
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

  async verifyCredentials(): Promise<ProviderHealth> {
    await this.listZones()
    return { ok: true }
  }

  async listZones(): Promise<DnsZone[]> {
    const domains = await this.http.request<HostingerDomain[]>('/api/domains/v1/portfolio')
    return domains.flatMap((domain) => {
      const zone = toZone(domain)
      return zone ? [zone] : []
    })
  }

  async getZone(domain: string): Promise<DnsZone | null> {
    const normalized = normalizeDomain(domain)
    const zones = await this.listZones()
    return zones.find((zone) => zone.name === normalized) ?? null
  }

  async listRecords(zone: DnsZone): Promise<DnsRecord[]> {
    const records = await this.http.request<HostingerZoneRecord[]>(`/api/dns/v1/zones/${encodeURIComponent(zone.name)}`)
    return records.flatMap((record) => toDnsRecords(record, zone))
  }

  async planChanges(zone: DnsZone, desired: DnsRecordInput[], opts: { force?: boolean } = {}): Promise<DnsChangePlan> {
    const plan = planDnsChanges({
      desired,
      existing: await this.listRecords(zone),
      force: opts.force,
      providerId: this.id,
      zone,
    })
    return collapseRecordSetWrites(plan)
  }

  async applyChanges(zone: DnsZone, plan: DnsChangePlan): Promise<{ applied: DnsChange[]; skipped: DnsRecordInput[] }> {
    assertNoConflicts(this.id, plan)
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
      const remaining = plan.existing.filter((record) => sameRecordSet(record, sample) && !deleted.includes(record))
      if (remaining.length > 0) await this.putRecords(zone, remaining, true)
      else await this.deleteRecord(zone, sample)
      applied.push(...plan.changes.filter((change) => change.action === 'delete' && deleted.includes(change.existing)))
    }

    for (const change of plan.changes) {
      if (change.action === 'skip') {
        skipped.push(change.record)
        continue
      }

      if (change.action === 'delete') continue
      await this.putRecords(zone, [change.record], change.action === 'update')

      applied.push(change)
    }

    return { applied, skipped }
  }

  async upsertRecord(zone: DnsZone, record: DnsRecordInput): Promise<DnsRecord> {
    await this.putRecords(zone, [record], true)
    return { ...record, ttl: record.ttl ?? capabilities.defaultTtl }
  }

  async deleteRecord(zone: DnsZone, record: DnsRecord): Promise<void> {
    await this.http.request(`/api/dns/v1/zones/${encodeURIComponent(zone.name)}`, {
      body: { filters: [deleteFilter(record)] },
      method: 'DELETE',
    })
  }

  private async putRecords(zone: DnsZone, records: DnsRecordInput[], overwrite: boolean): Promise<void> {
    await this.http.request(`/api/dns/v1/zones/${encodeURIComponent(zone.name)}`, {
      body: { overwrite, zone: records.map(toHostingerRecord) },
      method: 'PUT',
    })
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
