export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT'

export interface CredentialDefinition {
  description?: string
  env: string
  hint?: string
  key: string
  label: string
  placeholder?: string
  required?: boolean
  secret?: boolean
}

export interface ProviderSetupGuide {
  notes?: string[]
}

export interface ProviderCapabilities {
  defaultTtl: number
  maxTtl?: number
  minTtl?: number
  recordTypes: DnsRecordType[]
  supportsApexCname: boolean
  supportsBulkWrites: boolean
  supportsPagination: boolean
  supportsProxying: boolean
  supportsRecordIds: boolean
}

export interface DnsZone {
  id: string
  name: string
  metadata?: Record<string, unknown>
}

export interface DnsRecord {
  id?: string
  metadata?: Record<string, unknown>
  name: string
  priority?: number
  proxied?: boolean
  ttl?: number
  type: DnsRecordType
  value: string
}

export interface DnsRecordInput {
  metadata?: Record<string, unknown>
  name: string
  priority?: number
  proxied?: boolean
  ttl?: number
  type: DnsRecordType
  value: string
}

export type DnsChange =
  | {action: 'create'; record: DnsRecordInput}
  | {action: 'delete'; existing: DnsRecord; reason?: string}
  | {action: 'skip'; existing: DnsRecord; reason: string; record: DnsRecordInput}
  | {action: 'update'; existing: DnsRecord; record: DnsRecordInput}

export interface DnsConflict {
  existing: DnsRecord
  reason: string
  record: DnsRecordInput
}

export interface DnsChangePlan {
  changes: DnsChange[]
  conflicts: DnsConflict[]
  desired: DnsRecordInput[]
  existing: DnsRecord[]
  zone: DnsZone
}

export interface DnsChangeResult {
  applied: DnsChange[]
  skipped: DnsRecordInput[]
}

export interface ListZonesInput {
  search?: string
}

export interface ProviderHealth {
  ok: boolean
  message?: string
}

export interface PlanOptions {
  force?: boolean
}

export interface ApplyOptions {
  force?: boolean
}

export interface ProviderContext {
  credentials: Record<string, string>
  debug?: boolean
  signal?: AbortSignal
}

export interface DnsProvider {
  capabilities: ProviderCapabilities
  id: string
  name: string
  applyChanges(zone: DnsZone, plan: DnsChangePlan, opts?: ApplyOptions): Promise<DnsChangeResult>
  deleteRecord(zone: DnsZone, record: DnsRecord): Promise<void>
  getZone(domain: string): Promise<DnsZone | null>
  listRecords(zone: DnsZone): Promise<DnsRecord[]>
  listZones(input?: ListZonesInput): Promise<DnsZone[]>
  planChanges(zone: DnsZone, desired: DnsRecordInput[], opts?: PlanOptions): Promise<DnsChangePlan>
  upsertRecord(zone: DnsZone, record: DnsRecordInput): Promise<DnsRecord>
  verifyCredentials(): Promise<ProviderHealth>
}

export interface DnsProviderDefinition {
  capabilities: ProviderCapabilities
  credentials: CredentialDefinition[]
  displayName: string
  docsUrl?: string
  id: string
  name: string
  setup?: ProviderSetupGuide
  create(context: ProviderContext): DnsProvider
}
