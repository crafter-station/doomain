import {XMLParser} from 'fast-xml-parser'

import {normalizeDomain} from '../../validate.js'
import {ProviderError} from '../core/errors.js'
import {assertNoConflicts, planDnsChanges} from '../core/planner.js'
import type {
  DnsChange,
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

const NAMECHEAP_PRODUCTION_URL = 'https://api.namecheap.com/xml.response'
const NAMECHEAP_SANDBOX_URL = 'https://api.sandbox.namecheap.com/xml.response'

const capabilities: ProviderCapabilities = {
  defaultTtl: 1800,
  recordTypes: ['A', 'AAAA', 'CNAME', 'MX', 'TXT'],
  supportsApexCname: false,
  supportsBulkWrites: true,
  supportsPagination: true,
  supportsProxying: false,
  supportsRecordIds: true,
}

const parser = new XMLParser({
  attributeNamePrefix: '',
  ignoreAttributes: false,
})

interface NamecheapDomain {
  Name?: string
}

interface NamecheapHost {
  Address?: string
  HostId?: string
  MXPref?: number | string
  Name?: string
  TTL?: number | string
  Type?: string
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function bool(value?: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true'
  return false
}

function getErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && '#text' in error) return String((error as {'#text': unknown})['#text'])
  return JSON.stringify(error)
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim()) return Number(value)
  return undefined
}

function pagingTotal(commandResponse: Record<string, unknown>, result: Record<string, unknown>, fallback: number): number {
  const paging = (commandResponse.Paging ?? result.Paging) as Record<string, unknown> | undefined
  return numberValue(paging?.TotalItems) ?? numberValue(paging?.totalItems) ?? fallback
}

function providerCodeFromNamecheapError(message: string) {
  const lower = message.toLowerCase()
  if (lower.includes('clientip') || lower.includes('client ip') || lower.includes('whitelist')) return 'PROVIDER_PERMISSION_DENIED'
  if (lower.includes('api key') || lower.includes('apiuser') || lower.includes('username') || lower.includes('authentication')) {
    return 'PROVIDER_AUTH_FAILED'
  }

  if (lower.includes('rate')) return 'PROVIDER_RATE_LIMITED'
  return 'PROVIDER_API_ERROR'
}

function namecheapSetupHelp(code: ReturnType<typeof providerCodeFromNamecheapError>): string | undefined {
  if (code !== 'PROVIDER_AUTH_FAILED' && code !== 'PROVIDER_PERMISSION_DENIED') return undefined
  return 'Make sure API access is enabled and your current public IPv4 is whitelisted at https://ap.www.namecheap.com/settings/tools/apiaccess/.'
}

function splitDomain(domain: string): {sld: string; tld: string} {
  const normalized = normalizeDomain(domain)
  const [sld, ...rest] = normalized.split('.')
  if (!sld || rest.length === 0) throw new ProviderError('namecheap', 'PROVIDER_ZONE_NOT_FOUND', `Invalid Namecheap domain: ${domain}`)
  return {sld, tld: rest.join('.')}
}

function toZone(domain: NamecheapDomain): DnsZone | null {
  if (!domain.Name) return null
  try {
    const name = normalizeDomain(domain.Name)
    return {id: name, name}
  } catch {
    return null
  }
}

function toDnsRecord(host: NamecheapHost): DnsRecord | null {
  if (!host.Name || !host.Type || !host.Address) return null
  const record: DnsRecord = {
    metadata: {namecheap: host},
    name: host.Name,
    type: host.Type as DnsRecord['type'],
    value: host.Address,
  }

  if (host.HostId !== undefined) record.id = host.HostId
  if (host.MXPref !== undefined) record.priority = Number(host.MXPref)
  if (host.TTL !== undefined) record.ttl = Number(host.TTL)

  return record
}

function sameRecord(a: DnsRecord | DnsRecordInput, b: DnsRecord | DnsRecordInput): boolean {
  return a.name === b.name && a.type === b.type && a.value === b.value
}

function inputToRecord(record: DnsRecordInput): DnsRecord {
  return {...record}
}

function hostParams(records: DnsRecord[]): Record<string, string> {
  const params: Record<string, string> = {}
  let position = 1
  for (const record of records) {
    params[`HostName${position}`] = record.name
    params[`RecordType${position}`] = record.type
    params[`Address${position}`] = record.value
    params[`TTL${position}`] = String(record.ttl ?? capabilities.defaultTtl)
    if (record.priority !== undefined) params[`MXPref${position}`] = String(record.priority)
    position += 1
  }

  return params
}

export class NamecheapProvider implements DnsProvider {
  readonly capabilities = capabilities
  readonly id = 'namecheap'
  readonly name = 'Namecheap'
  private readonly apiKey: string
  private readonly apiUser: string
  private readonly baseUrl: string
  private readonly clientIp: string
  private readonly username: string

  constructor(context: ProviderContext) {
    this.apiUser = context.credentials.apiUser
    this.apiKey = context.credentials.apiKey
    this.username = context.credentials.username || context.credentials.apiUser
    this.clientIp = context.credentials.clientIp
    this.baseUrl = bool(context.credentials.sandbox) ? NAMECHEAP_SANDBOX_URL : NAMECHEAP_PRODUCTION_URL
  }

  async verifyCredentials(): Promise<ProviderHealth> {
    await this.listZones()
    return {ok: true}
  }

  async listZones(): Promise<DnsZone[]> {
    const zones: DnsZone[] = []
    let currentPage = 1
    let totalItems = Number.POSITIVE_INFINITY

    while (zones.length < totalItems) {
      const response = await this.request('namecheap.domains.getList', {Page: String(currentPage), PageSize: '100'})
      const commandResponse = response.ApiResponse.CommandResponse
      const result = commandResponse.DomainGetListResult
      const domains = asArray<NamecheapDomain>(result.Domain)

      for (const domain of domains) {
        const zone = toZone(domain)
        if (zone) zones.push(zone)
      }

      totalItems = pagingTotal(commandResponse, result, zones.length)
      if (domains.length === 0) break
      currentPage += 1
    }

    return zones
  }

  async getZone(domain: string): Promise<DnsZone | null> {
    const normalized = normalizeDomain(domain)
    const zones = await this.listZones()
    return zones.find((zone) => zone.name === normalized) ?? null
  }

  async listRecords(zone: DnsZone): Promise<DnsRecord[]> {
    const {sld, tld} = splitDomain(zone.name)
    const response = await this.request('namecheap.domains.dns.getHosts', {SLD: sld, TLD: tld})
    const hosts = asArray<NamecheapHost>(response.ApiResponse.CommandResponse.DomainDNSGetHostsResult.host)
    return hosts.flatMap((host) => {
      const record = toDnsRecord(host)
      return record ? [record] : []
    })
  }

  async planChanges(zone: DnsZone, desired: DnsRecordInput[], opts: {force?: boolean} = {}): Promise<DnsChangePlan> {
    return planDnsChanges({desired, existing: await this.listRecords(zone), force: opts.force, providerId: this.id, zone})
  }

  async applyChanges(zone: DnsZone, plan: DnsChangePlan): Promise<{applied: DnsChange[]; skipped: DnsRecordInput[]}> {
    assertNoConflicts(this.id, plan)
    const finalRecords = [...plan.existing]
    const applied: DnsChange[] = []
    const skipped: DnsRecordInput[] = []

    for (const change of plan.changes) {
      if (change.action === 'skip') {
        skipped.push(change.record)
        continue
      }

      if (change.action === 'delete') {
        const index = finalRecords.findIndex((record) => sameRecord(record, change.existing))
        if (index !== -1) finalRecords.splice(index, 1)
      } else if (change.action === 'update') {
        const index = finalRecords.findIndex((record) => sameRecord(record, change.existing))
        if (index !== -1) finalRecords[index] = {...change.existing, ...change.record}
      } else {
        finalRecords.push(inputToRecord(change.record))
      }

      applied.push(change)
    }

    if (applied.length > 0) await this.setHosts(zone, finalRecords)
    return {applied, skipped}
  }

  async upsertRecord(zone: DnsZone, record: DnsRecordInput): Promise<DnsRecord> {
    const plan = await this.planChanges(zone, [record], {force: true})
    await this.applyChanges(zone, plan)
    return {...record, ttl: record.ttl ?? capabilities.defaultTtl}
  }

  async deleteRecord(zone: DnsZone, record: DnsRecord): Promise<void> {
    const records = (await this.listRecords(zone)).filter((item) => !sameRecord(item, record))
    await this.setHosts(zone, records)
  }

  private async setHosts(zone: DnsZone, records: DnsRecord[]): Promise<void> {
    const {sld, tld} = splitDomain(zone.name)
    const response = await this.request('namecheap.domains.dns.setHosts', {SLD: sld, TLD: tld, ...hostParams(records)}, {method: 'POST'})
    const result = response.ApiResponse.CommandResponse.DomainDNSSetHostsResult
    if (!bool(result?.IsSuccess)) {
      throw new ProviderError(
        'namecheap',
        'PROVIDER_API_ERROR',
        'Namecheap did not confirm DNS host records were updated.',
        result,
      )
    }
  }

  private async request(command: string, params: Record<string, string>, opts: {method?: 'GET' | 'POST'} = {}) {
    if (!this.clientIp) {
      throw new ProviderError('namecheap', 'MISSING_CREDENTIALS', 'Namecheap requires a whitelisted IPv4 ClientIp credential.')
    }

    const query = new URLSearchParams({
      ApiKey: this.apiKey,
      ApiUser: this.apiUser,
      ClientIp: this.clientIp,
      Command: command,
      UserName: this.username,
      ...params,
    })
    const method = opts.method ?? 'GET'
    const response = await fetch(method === 'POST' ? this.baseUrl : `${this.baseUrl}?${query.toString()}`, {
      ...(method === 'POST'
        ? {body: query.toString(), headers: {'Content-Type': 'application/x-www-form-urlencoded'}, method}
        : {}),
    })

    if (!response.ok) {
      throw new ProviderError('namecheap', 'PROVIDER_API_ERROR', `Namecheap API error (${response.status}).`)
    }

    const data = parser.parse(await response.text())
    const status = data.ApiResponse?.Status
    if (status !== 'OK') {
      const message = getErrorMessage(asArray(data.ApiResponse?.Errors?.Error)[0] ?? 'Namecheap API error.')
      const code = providerCodeFromNamecheapError(message)
      const help = namecheapSetupHelp(code)
      throw new ProviderError('namecheap', code, help ? `${message} ${help}` : message, data.ApiResponse?.Errors)
    }

    return data
  }
}

export const namecheapProviderDefinition: DnsProviderDefinition = {
  capabilities,
  credentials: [
    {env: 'NAMECHEAP_API_USER', key: 'apiUser', label: 'API user', required: true},
    {env: 'NAMECHEAP_API_KEY', key: 'apiKey', label: 'API key', required: true, secret: true},
    {env: 'NAMECHEAP_USERNAME', key: 'username', label: 'Username', required: false},
    {
      env: 'NAMECHEAP_CLIENT_IP',
      hint: 'Must match the IPv4 address whitelisted in Namecheap API Access settings.',
      key: 'clientIp',
      label: 'Whitelisted client IP',
      required: true,
    },
    {env: 'NAMECHEAP_SANDBOX', key: 'sandbox', label: 'Use sandbox', required: false},
  ],
  displayName: 'Namecheap',
  docsUrl: 'https://www.namecheap.com/support/api/methods/',
  id: 'namecheap',
  name: 'Namecheap',
  setup: {
    notes: [
      'Open Account Dashboard > Profile > Tools > API Access:',
      'https://ap.www.namecheap.com/settings/tools/apiaccess/',
      'Enable API access, copy your API key, and add your current public IPv4 to Whitelisted IPs.',
      'DMLink preserves existing records when updating Namecheap DNS, but Namecheap host writes replace the full host list.',
    ],
  },
  create(context) {
    return new NamecheapProvider(context)
  },
}
