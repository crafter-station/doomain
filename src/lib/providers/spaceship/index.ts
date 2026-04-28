import {normalizeDomain} from '../../validate.js'
import {createProviderHttpClient, type ProviderHttpClient} from '../core/http.js'
import {paginateBySkip} from '../core/pagination.js'
import {applyDnsChanges, planDnsChanges} from '../core/planner.js'
import type {
  DnsChangePlan,
  DnsProvider,
  DnsProviderDefinition,
  DnsRecord,
  DnsRecordInput,
  DnsZone,
  ProviderCapabilities,
  ProviderContext,
  ProviderHealth,
} from '../types.js'

const SPACESHIP_API_URL = 'https://spaceship.dev/api/v1'

const capabilities: ProviderCapabilities = {
  defaultTtl: 3600,
  recordTypes: ['A', 'AAAA', 'CNAME', 'MX', 'TXT'],
  supportsApexCname: false,
  supportsBulkWrites: true,
  supportsPagination: true,
  supportsProxying: false,
  supportsRecordIds: false,
}

interface SpaceshipRecord {
  address?: string
  cname?: string
  name: string
  ttl?: number
  type: string
  value?: string
}

interface SpaceshipDomain {
  name?: string
  unicodeName?: string
}

function recordValue(record: SpaceshipRecord): string {
  return record.cname ?? record.address ?? record.value ?? ''
}

function toSpaceshipItem(record: DnsRecordInput): SpaceshipRecord {
  const base = {
    name: record.name,
    ttl: record.ttl ?? capabilities.defaultTtl,
    type: record.type,
  }

  if (record.type === 'CNAME') return {...base, cname: record.value}
  if (record.type === 'A' || record.type === 'AAAA') return {...base, address: record.value}
  return {...base, value: record.value}
}

function toDnsRecord(record: SpaceshipRecord): DnsRecord {
  return {
    name: record.name,
    ttl: record.ttl,
    type: record.type as DnsRecord['type'],
    value: recordValue(record),
  }
}

function toZone(domain: SpaceshipDomain): DnsZone | null {
  const name = domain.name ?? domain.unicodeName
  if (!name) return null

  try {
    const normalized = normalizeDomain(name)
    return {id: normalized, name: normalized}
  } catch {
    return null
  }
}

export class SpaceshipProvider implements DnsProvider {
  readonly capabilities = capabilities
  readonly id = 'spaceship'
  readonly name = 'Spaceship'
  private readonly http: ProviderHttpClient

  constructor(context: ProviderContext) {
    this.http = createProviderHttpClient({
      baseUrl: SPACESHIP_API_URL,
      errorMessages: {
        401: 'Spaceship rejected the API key/secret. Re-run `doomain providers connect spaceship` with valid credentials.',
        403: 'Spaceship API key is missing required scopes. Enable domains:read and dnsrecords:read/write.',
        429: 'Spaceship rate limit exceeded. Try again later.',
      },
      headers: {
        'X-Api-Key': context.credentials.apiKey,
        'X-Api-Secret': context.credentials.apiSecret,
      },
      providerId: this.id,
      signal: context.signal,
    })
  }

  async verifyCredentials(): Promise<ProviderHealth> {
    await this.listZones()
    return {ok: true}
  }

  async listZones(): Promise<DnsZone[]> {
    const domains = await paginateBySkip<SpaceshipDomain>({
      take: 100,
      fetchPage: ({skip, take}) =>
        this.http.request<{items: SpaceshipDomain[]; total: number}>('/domains', {
          query: {orderBy: 'name', skip, take},
        }),
    })

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
    const records = await paginateBySkip<SpaceshipRecord>({
      take: 500,
      fetchPage: ({skip, take}) =>
        this.http.request<{items: SpaceshipRecord[]; total: number}>(`/dns/records/${zone.name}`, {
          query: {skip, take},
        }),
    })

    return records.map(toDnsRecord)
  }

  async planChanges(zone: DnsZone, desired: DnsRecordInput[], opts: {force?: boolean} = {}): Promise<DnsChangePlan> {
    return planDnsChanges({
      desired,
      existing: await this.listRecords(zone),
      force: opts.force,
      providerId: this.id,
      zone,
    })
  }

  async applyChanges(zone: DnsZone, plan: DnsChangePlan): Promise<{applied: DnsChangePlan['changes']; skipped: DnsRecordInput[]}> {
    return applyDnsChanges({
      deleteRecord: (record) => this.deleteRecord(zone, record),
      plan,
      providerId: this.id,
      upsertRecord: (record) => this.upsertRecord(zone, record),
    })
  }

  async upsertRecord(zone: DnsZone, record: DnsRecordInput): Promise<DnsRecord> {
    await this.http.request(`/dns/records/${zone.name}`, {
      body: {force: true, items: [toSpaceshipItem(record)]},
      method: 'PUT',
    })

    return {...record, ttl: record.ttl ?? capabilities.defaultTtl}
  }

  async deleteRecord(zone: DnsZone, record: DnsRecord): Promise<void> {
    await this.http.request(`/dns/records/${zone.name}`, {
      body: [toSpaceshipItem(record)],
      method: 'DELETE',
    })
  }
}

export const spaceshipProviderDefinition: DnsProviderDefinition = {
  capabilities,
  credentials: [
    {env: 'SPACESHIP_API_KEY', key: 'apiKey', label: 'API key', required: true, secret: true},
    {env: 'SPACESHIP_API_SECRET', key: 'apiSecret', label: 'API secret', required: true, secret: true},
  ],
  displayName: 'Spaceship',
  docsUrl: 'https://docs.spaceship.dev/',
  id: 'spaceship',
  name: 'Spaceship',
  setup: {
    notes: ['Create a Spaceship API key with domain and DNS record access before connecting.'],
  },
  create(context) {
    return new SpaceshipProvider(context)
  },
}
