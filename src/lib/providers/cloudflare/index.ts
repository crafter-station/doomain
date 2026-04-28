import {normalizeDomain} from '../../validate.js'
import {createProviderHttpClient, type ProviderHttpClient} from '../core/http.js'
import {assertNoConflicts, planDnsChanges} from '../core/planner.js'
import {ProviderError} from '../core/errors.js'
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

const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4'

const capabilities: ProviderCapabilities = {
  defaultTtl: 3600,
  maxTtl: 86_400,
  minTtl: 60,
  recordTypes: ['A', 'AAAA', 'CNAME', 'MX', 'TXT'],
  supportsApexCname: false,
  supportsBulkWrites: false,
  supportsPagination: true,
  supportsProxying: true,
  supportsRecordIds: true,
}

interface CloudflareResponseInfo {
  code?: number
  message?: string
}

interface CloudflareResponse<T> {
  errors?: CloudflareResponseInfo[]
  result?: T
  result_info?: {
    count?: number
    page?: number
    per_page?: number
    total_count?: number
    total_pages?: number
  }
  success?: boolean
}

interface CloudflareZone {
  id?: string
  name?: string
}

interface CloudflareRecord {
  content?: string
  id?: string
  name?: string
  priority?: number
  proxied?: boolean
  ttl?: number
  type?: string
}

function cloudflareErrorMessage(response: CloudflareResponse<unknown>): string {
  return response.errors?.find((error) => error.message)?.message ?? 'Cloudflare API error.'
}

function isSupportedRecordType(type?: string): type is DnsRecordType {
  return capabilities.recordTypes.includes(type as DnsRecordType)
}

function cleanDnsRecordName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '')
}

function relativeRecordName(name: string, zoneName: string): string {
  const normalized = cleanDnsRecordName(name)
  const normalizedZone = normalizeDomain(zoneName)
  if (normalized === normalizedZone) return '@'
  if (normalized.endsWith(`.${normalizedZone}`)) return normalized.slice(0, -(normalizedZone.length + 1))
  return normalized
}

function absoluteRecordName(record: DnsRecordInput, zone: DnsZone): string {
  return record.name === '@' ? zone.name : `${record.name}.${zone.name}`
}

function toDnsRecord(record: CloudflareRecord, zone: DnsZone): DnsRecord | null {
  if (!record.id || !record.name || !record.type || !record.content || !isSupportedRecordType(record.type)) return null
  const dnsRecord: DnsRecord = {
    id: record.id,
    metadata: {cloudflare: record},
    name: relativeRecordName(record.name, zone.name),
    type: record.type,
    value: record.content,
  }

  if (record.priority !== undefined) dnsRecord.priority = record.priority
  if (record.proxied !== undefined) dnsRecord.proxied = record.proxied
  if (record.ttl !== undefined) dnsRecord.ttl = record.ttl

  return dnsRecord
}

function toCloudflareRecord(record: DnsRecordInput, zone: DnsZone) {
  return {
    content: record.value,
    name: absoluteRecordName(record, zone),
    ttl: record.ttl ?? capabilities.defaultTtl,
    type: record.type,
    ...(record.priority === undefined ? {} : {priority: record.priority}),
    ...(record.proxied === undefined || !['A', 'AAAA', 'CNAME'].includes(record.type) ? {} : {proxied: record.proxied}),
  }
}

function toZone(zone: CloudflareZone): DnsZone | null {
  if (!zone.id || !zone.name) return null
  try {
    const name = normalizeDomain(zone.name)
    return {id: zone.id, metadata: {cloudflare: zone}, name}
  } catch {
    return null
  }
}

export class CloudflareProvider implements DnsProvider {
  readonly capabilities = capabilities
  readonly id = 'cloudflare'
  readonly name = 'Cloudflare'
  private readonly accountId: string
  private readonly http: ProviderHttpClient

  constructor(context: ProviderContext) {
    this.accountId = context.credentials.accountId
    this.http = createProviderHttpClient({
      baseUrl: CLOUDFLARE_API_URL,
      errorMessages: {
        401: 'Cloudflare rejected the API token.',
        403: 'Cloudflare API token is missing required permissions. Enable Zone:Read and DNS:Edit for the account.',
        429: 'Cloudflare rate limit exceeded. Try again later.',
      },
      headers: {Authorization: `Bearer ${context.credentials.apiToken}`},
      providerId: this.id,
      signal: context.signal,
    })
  }

  async verifyCredentials(): Promise<ProviderHealth> {
    await this.listZones()
    return {ok: true}
  }

  async listZones(): Promise<DnsZone[]> {
    const zones: DnsZone[] = []

    for (let page = 1; page <= 100; page += 1) {
      const response = await this.request<CloudflareZone[]>('/zones', {
        query: {'account.id': this.accountId, direction: 'asc', order: 'name', page, 'per_page': 50},
      })

      for (const zone of response.result ?? []) {
        const dnsZone = toZone(zone)
        if (dnsZone) zones.push(dnsZone)
      }

      const totalPages = response.result_info?.total_pages ?? page
      if (page >= totalPages || (response.result ?? []).length === 0) break
    }

    return zones
  }

  async getZone(domain: string): Promise<DnsZone | null> {
    const normalized = normalizeDomain(domain)
    const zones = await this.listZones()
    return zones.find((zone) => zone.name === normalized) ?? null
  }

  async listRecords(zone: DnsZone): Promise<DnsRecord[]> {
    const records: DnsRecord[] = []

    for (let page = 1; page <= 100; page += 1) {
      const response = await this.request<CloudflareRecord[]>(`/zones/${zone.id}/dns_records`, {
        query: {page, 'per_page': 100},
      })

      for (const record of response.result ?? []) {
        const dnsRecord = toDnsRecord(record, zone)
        if (dnsRecord) records.push(dnsRecord)
      }

      const totalPages = response.result_info?.total_pages ?? page
      if (page >= totalPages || (response.result ?? []).length === 0) break
    }

    return records
  }

  async planChanges(zone: DnsZone, desired: DnsRecordInput[], opts: {force?: boolean} = {}): Promise<DnsChangePlan> {
    return planDnsChanges({desired, existing: await this.listRecords(zone), force: opts.force, providerId: this.id, zone})
  }

  async applyChanges(zone: DnsZone, plan: DnsChangePlan): Promise<{applied: DnsChange[]; skipped: DnsRecordInput[]}> {
    assertNoConflicts(this.id, plan)
    const applied: DnsChange[] = []
    const skipped: DnsRecordInput[] = []

    for (const change of plan.changes) {
      if (change.action === 'skip') {
        skipped.push(change.record)
        continue
      }

      if (change.action === 'delete') await this.deleteRecord(zone, change.existing)
      else if (change.action === 'update') await this.updateRecord(zone, change.existing, change.record)
      else await this.createRecord(zone, change.record)

      applied.push(change)
    }

    return {applied, skipped}
  }

  async upsertRecord(zone: DnsZone, record: DnsRecordInput): Promise<DnsRecord> {
    const existing = (await this.listRecords(zone)).find((item) => item.name === record.name && item.type === record.type)
    if (existing) return this.updateRecord(zone, existing, record)
    return this.createRecord(zone, record)
  }

  async deleteRecord(zone: DnsZone, record: DnsRecord): Promise<void> {
    if (!record.id) throw new ProviderError(this.id, 'PROVIDER_API_ERROR', 'Cloudflare DNS record id is required to delete a record.')
    await this.request(`/zones/${zone.id}/dns_records/${record.id}`, {method: 'DELETE'})
  }

  private async createRecord(zone: DnsZone, record: DnsRecordInput): Promise<DnsRecord> {
    const response = await this.request<CloudflareRecord>(`/zones/${zone.id}/dns_records`, {
      body: toCloudflareRecord(record, zone),
      method: 'POST',
    })
    const created = response.result ? toDnsRecord(response.result, zone) : null
    return created ?? {...record, ttl: record.ttl ?? capabilities.defaultTtl}
  }

  private async updateRecord(zone: DnsZone, existing: DnsRecord, record: DnsRecordInput): Promise<DnsRecord> {
    if (!existing.id) throw new ProviderError(this.id, 'PROVIDER_API_ERROR', 'Cloudflare DNS record id is required to update a record.')
    const response = await this.request<CloudflareRecord>(`/zones/${zone.id}/dns_records/${existing.id}`, {
      body: toCloudflareRecord(record, zone),
      method: 'PUT',
    })
    const updated = response.result ? toDnsRecord(response.result, zone) : null
    return updated ?? {...record, id: existing.id, ttl: record.ttl ?? capabilities.defaultTtl}
  }

  private async request<T>(path: string, init: Parameters<ProviderHttpClient['request']>[1] = {}) {
    const response = await this.http.request<CloudflareResponse<T>>(path, init)
    if (response.success === false) {
      throw new ProviderError(this.id, 'PROVIDER_API_ERROR', cloudflareErrorMessage(response), response.errors)
    }

    return response
  }
}

export const cloudflareProviderDefinition: DnsProviderDefinition = {
  capabilities,
  credentials: [
    {env: 'CLOUDFLARE_API_TOKEN', key: 'apiToken', label: 'API token', required: true, secret: true},
    {env: 'CLOUDFLARE_ACCOUNT_ID', key: 'accountId', label: 'Account ID', required: true},
  ],
  displayName: 'Cloudflare',
  docsUrl: 'https://developers.cloudflare.com/api/',
  id: 'cloudflare',
  name: 'Cloudflare',
  setup: {
    notes: [
      'Create a Cloudflare API token with Zone:Read and DNS:Edit permissions for the account.',
      'Use the Cloudflare account ID that owns the DNS zones you want Doomain to manage.',
      'Doomain creates Vercel records as DNS-only records, not proxied records.',
    ],
  },
  create(context) {
    return new CloudflareProvider(context)
  },
}
