import { Effect } from 'effect'

import { type DoomainEffect, trySync } from '../../effect.js'
import { normalizeDomain } from '../../validate.js'
import { createProviderHttpClient, type ProviderHttpClient } from '../core/http.js'
import { paginateBySkip } from '../core/pagination.js'
import { assertNoConflicts, planDnsChanges } from '../core/planner.js'
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

  if (record.type === 'CNAME') return { ...base, cname: record.value }
  if (record.type === 'A' || record.type === 'AAAA') return { ...base, address: record.value }
  return { ...base, value: record.value }
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
    return { id: normalized, name: normalized }
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
      transportErrorCode: context.transportErrorCode,
    })
  }

  verifyCredentials(): DoomainEffect<ProviderHealth> {
    return this.listZones().pipe(Effect.as({ ok: true }))
  }

  listZones(): DoomainEffect<DnsZone[]> {
    return paginateBySkip<SpaceshipDomain>({
      take: 100,
      fetchPage: ({ skip, take }) =>
        this.http.request<{ items: SpaceshipDomain[]; total: number }>('/domains', {
          query: { orderBy: 'name', skip, take },
        }),
    }).pipe(
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
    return paginateBySkip<SpaceshipRecord>({
      take: 500,
      fetchPage: ({ skip, take }) =>
        this.http.request<{ items: SpaceshipRecord[]; total: number }>(`/dns/records/${zone.name}`, {
          query: { skip, take },
        }),
    }).pipe(Effect.map((records) => records.map(toDnsRecord)))
  }

  planChanges(zone: DnsZone, desired: DnsRecordInput[], opts: { force?: boolean } = {}): DoomainEffect<DnsChangePlan> {
    return this.listRecords(zone).pipe(
      Effect.map((existing) => planDnsChanges({ desired, existing, force: opts.force, providerId: this.id, zone })),
    )
  }

  applyChanges(
    zone: DnsZone,
    plan: DnsChangePlan,
  ): DoomainEffect<{ applied: DnsChangePlan['changes']; skipped: DnsRecordInput[] }> {
    return Effect.gen(this, function* () {
      yield* assertNoConflicts(this.id, plan)
      const skipped = plan.changes.flatMap((change) => (change.action === 'skip' ? [change.record] : []))
      const applied = plan.changes.filter((change) => change.action !== 'skip')

      // Spaceship records do not have stable ids. Delete every old value before creating
      // replacements so an API that processes accepted writes out of order cannot leave
      // two address records in the same slot without the reconciler noticing and retrying.
      for (const change of applied) {
        if (change.action === 'delete' || change.action === 'update') yield* this.deleteRecord(zone, change.existing)
      }
      for (const change of applied) {
        if (change.action === 'create' || change.action === 'update') yield* this.upsertRecord(zone, change.record)
      }

      return { applied, skipped }
    })
  }

  upsertRecord(zone: DnsZone, record: DnsRecordInput): DoomainEffect<DnsRecord> {
    return this.http
      .request(`/dns/records/${zone.name}`, {
        body: { force: true, items: [toSpaceshipItem(record)] },
        method: 'PUT',
      })
      .pipe(Effect.as({ ...record, ttl: record.ttl ?? capabilities.defaultTtl }))
  }

  deleteRecord(zone: DnsZone, record: DnsRecord): DoomainEffect<void> {
    return this.http
      .request(`/dns/records/${zone.name}`, {
        body: [toSpaceshipItem(record)],
        method: 'DELETE',
      })
      .pipe(Effect.asVoid)
  }
}

export const spaceshipProviderDefinition: DnsProviderDefinition = {
  capabilities,
  credentials: [
    { env: 'SPACESHIP_API_KEY', key: 'apiKey', label: 'API key', required: true, secret: true },
    { env: 'SPACESHIP_API_SECRET', key: 'apiSecret', label: 'API secret', required: true, secret: true },
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
