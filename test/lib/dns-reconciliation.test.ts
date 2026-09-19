import { strict as assert } from 'node:assert'
import { describe, it } from 'mocha'

import {
  reconcileDesiredRecord as reconcileDesiredRecordEffect,
  reconcileRecordRemoval as reconcileRecordRemovalEffect,
} from '../../src/lib/dns-reconciliation.js'
import { DoomainError } from '../../src/lib/errors.js'
import { planDnsChanges } from '../../src/lib/providers/core/planner.js'
import type { DnsRecord, DnsRecordInput, DnsZone } from '../../src/lib/providers/types.js'
import { effectProvider, type PromiseDnsProvider, runEffect } from '../helpers/effect.js'

type DesiredInput = Omit<Parameters<typeof reconcileDesiredRecordEffect>[0], 'provider'> & {
  provider: PromiseDnsProvider
}
type RemovalInput = Omit<Parameters<typeof reconcileRecordRemovalEffect>[0], 'provider'> & {
  provider: PromiseDnsProvider
}

const reconcileDesiredRecord = (input: DesiredInput) =>
  runEffect(reconcileDesiredRecordEffect({ ...input, provider: effectProvider(input.provider) }))
const reconcileRecordRemoval = (input: RemovalInput) =>
  runEffect(reconcileRecordRemovalEffect({ ...input, provider: effectProvider(input.provider) }))

const zone: DnsZone = { id: 'zone-1', name: 'example.com' }

function providerFixture(records: DnsRecord[]): PromiseDnsProvider {
  return {
    id: 'test',
    name: 'Test DNS',
    capabilities: {
      defaultTtl: 300,
      recordTypes: ['A', 'AAAA', 'CNAME'],
      supportsApexCname: false,
      supportsBulkWrites: true,
      supportsPagination: false,
      supportsProxying: false,
      supportsRecordIds: true,
    },
    applyChanges: async () => ({ applied: [], skipped: [] }),
    deleteRecord: async () => undefined,
    getZone: async () => zone,
    listRecords: async () => records,
    listZones: async () => [zone],
    planChanges: async (_zone, desired, opts) =>
      planDnsChanges({ desired, existing: records, force: opts?.force, providerId: 'test', zone }),
    upsertRecord: async (_zone, record) => record,
    verifyCredentials: async () => ({ ok: true }),
  }
}

describe('DNS reconciliation', () => {
  it('polls through reordered writes, delayed deletion, and delayed creation', async () => {
    const old: DnsRecord = { id: 'old', name: '@', type: 'A', value: '76.76.21.21' }
    const desired: DnsRecordInput = { name: '@', type: 'A', value: '203.0.113.10' }
    let records: DnsRecord[] = [old, desired]
    const provider = providerFixture(records)
    provider.listRecords = async () => records
    let now = 0
    let polls = 0

    const result = await reconcileDesiredRecord({
      dependencies: {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
          polls += 1
          records = polls === 1 ? [] : [{ ...desired }]
        },
      },
      desired,
      intervalMs: 1,
      provider,
      timeoutMs: 1000,
      zone,
    })

    assert.equal(result.appliedChanges, 0)
    assert.equal(result.attempts, 3)
    assert.deepEqual(records, [desired])
  })

  it('polls for a delayed deletion without replaying the accepted delete', async () => {
    const planned: DnsRecord = { id: 'planned', name: 'app', type: 'A', value: '203.0.113.10' }
    let records = [planned]
    let writes = 0
    let now = 0
    const provider = providerFixture(records)
    provider.listRecords = async () => records
    provider.applyChanges = async (_zone, plan) => {
      writes += 1
      return { applied: plan.changes, skipped: [] }
    }

    const result = await reconcileRecordRemoval({
      dependencies: {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
          records = []
        },
      },
      intervalMs: 1,
      provider,
      selector: { name: 'app', type: 'A', value: planned.value },
      timeoutMs: 1000,
      zone,
    })

    assert.equal(writes, 0)
    assert.equal(result.reconciled, true)
  })

  it('never retries an id-less deletion that could target a concurrent identical record', async () => {
    const planned: DnsRecord = { name: 'app', type: 'A', value: '203.0.113.10' }
    const concurrent: DnsRecord = { name: 'app', type: 'A', value: '203.0.113.10' }
    let now = 0
    let writes = 0
    const provider = providerFixture([concurrent])
    provider.applyChanges = async (_zone, plan) => {
      writes += 1
      return { applied: plan.changes, skipped: [] }
    }

    await assert.rejects(
      reconcileRecordRemoval({
        dependencies: {
          now: () => now,
          sleep: async (milliseconds) => {
            now += milliseconds
          },
        },
        intervalMs: 1,
        provider,
        selector: { name: 'app', type: 'A', value: planned.value },
        timeoutMs: 2,
        zone,
      }),
      (error: unknown) => error instanceof DoomainError && error.code === 'DNS_RECONCILIATION_INCOMPLETE',
    )
    assert.equal(writes, 0)
  })

  it('does not replay a create while an accepted write is still absent from stale reads', async () => {
    const desired: DnsRecordInput = { name: 'app', type: 'A', value: '203.0.113.10' }
    let now = 0
    let plans = 0
    const provider = providerFixture([])
    provider.planChanges = async (_zone, recordsToWrite, opts) => {
      plans += 1
      return planDnsChanges({ desired: recordsToWrite, existing: [], force: opts?.force, providerId: 'test', zone })
    }

    await assert.rejects(
      reconcileDesiredRecord({
        dependencies: {
          now: () => now,
          sleep: async (milliseconds) => {
            now += milliseconds
          },
        },
        desired,
        intervalMs: 1,
        provider,
        timeoutMs: 2,
        zone,
      }),
      (error: unknown) => error instanceof DoomainError && error.code === 'DNS_RECONCILIATION_INCOMPLETE',
    )
    assert.equal(plans, 0)
  })

  it('does not escalate an unforced reconciliation when a conflict appears', async () => {
    const desired: DnsRecordInput = { name: 'app', type: 'A', value: '203.0.113.10' }
    let now = 0
    let plans = 0
    const provider = providerFixture([{ name: 'app', type: 'A', value: '192.0.2.1' }])
    provider.planChanges = async (_zone, recordsToWrite, opts) => {
      plans += 1
      return planDnsChanges({ desired: recordsToWrite, existing: [], force: opts?.force, providerId: 'test', zone })
    }

    await assert.rejects(
      reconcileDesiredRecord({
        dependencies: {
          now: () => now,
          sleep: async (milliseconds) => {
            now += milliseconds
          },
        },
        desired,
        intervalMs: 1,
        provider,
        timeoutMs: 2,
        zone,
      }),
      (error: unknown) => error instanceof DoomainError && error.code === 'DNS_RECONCILIATION_INCOMPLETE',
    )
    assert.equal(plans, 0)
  })

  it('does not replay a forced replacement from an old-only stale view', async () => {
    const desired: DnsRecordInput = { name: 'app', type: 'A', value: '203.0.113.10' }
    let now = 0
    let plans = 0
    const provider = providerFixture([{ id: 'old-cname', name: 'app', type: 'CNAME', value: 'old.example.net' }])
    provider.planChanges = async (_zone, recordsToWrite, opts) => {
      plans += 1
      return planDnsChanges({ desired: recordsToWrite, existing: [], force: opts?.force, providerId: 'test', zone })
    }

    await assert.rejects(
      reconcileDesiredRecord({
        dependencies: {
          now: () => now,
          sleep: async (milliseconds) => {
            now += milliseconds
          },
        },
        desired,
        intervalMs: 1,
        provider,
        timeoutMs: 2,
        zone,
      }),
      (error: unknown) => error instanceof DoomainError && error.code === 'DNS_RECONCILIATION_INCOMPLETE',
    )
    assert.equal(plans, 0)
  })
})
