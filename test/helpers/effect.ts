import { Effect } from 'effect'

import type { DoomainEffect } from '../../src/lib/effect.js'
import { runDoomainEffect } from '../../src/lib/effect.js'
import { toDoomainError } from '../../src/lib/errors.js'
import type {
  ApplyOptions,
  DnsChangePlan,
  DnsChangeResult,
  DnsProvider,
  DnsRecord,
  DnsRecordInput,
  DnsZone,
  ListZonesInput,
  PlanOptions,
  ProviderCapabilities,
  ProviderHealth,
} from '../../src/lib/providers/types.js'

export const runEffect = runDoomainEffect

export const effectFromPromise = <A>(evaluate: () => Promise<A>): DoomainEffect<A> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => toDoomainError(cause, 'DOMAIN_LINK_FAILED'),
  })

export interface PromiseDnsProvider {
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

export function promiseProvider(provider: DnsProvider): PromiseDnsProvider {
  return {
    capabilities: provider.capabilities,
    id: provider.id,
    name: provider.name,
    applyChanges: (zone, plan, opts) => runEffect(provider.applyChanges(zone, plan, opts)),
    deleteRecord: (zone, record) => runEffect(provider.deleteRecord(zone, record)),
    getZone: (domain) => runEffect(provider.getZone(domain)),
    listRecords: (zone) => runEffect(provider.listRecords(zone)),
    listZones: (input) => runEffect(provider.listZones(input)),
    planChanges: (zone, desired, opts) => runEffect(provider.planChanges(zone, desired, opts)),
    upsertRecord: (zone, record) => runEffect(provider.upsertRecord(zone, record)),
    verifyCredentials: () => runEffect(provider.verifyCredentials()),
  }
}

export function effectProvider(provider: PromiseDnsProvider): DnsProvider {
  return {
    capabilities: provider.capabilities,
    id: provider.id,
    name: provider.name,
    applyChanges: (zone, plan, opts) => effectFromPromise(() => provider.applyChanges(zone, plan, opts)),
    deleteRecord: (zone, record) => effectFromPromise(() => provider.deleteRecord(zone, record)),
    getZone: (domain) => effectFromPromise(() => provider.getZone(domain)),
    listRecords: (zone) => effectFromPromise(() => provider.listRecords(zone)),
    listZones: (input) => effectFromPromise(() => provider.listZones(input)),
    planChanges: (zone, desired, opts) => effectFromPromise(() => provider.planChanges(zone, desired, opts)),
    upsertRecord: (zone, record) => effectFromPromise(() => provider.upsertRecord(zone, record)),
    verifyCredentials: () => effectFromPromise(() => provider.verifyCredentials()),
  }
}
