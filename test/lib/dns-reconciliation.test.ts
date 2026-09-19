import { strict as assert } from 'node:assert'
import { describe, it } from 'mocha'

import { reconcileDesiredRecord, reconcileRecordRemoval } from '../../src/lib/dns-reconciliation.js'
import { DoomainError } from '../../src/lib/errors.js'
import { planDnsChanges } from '../../src/lib/providers/core/planner.js'
import type { DnsProvider, DnsRecord, DnsRecordInput, DnsZone } from '../../src/lib/providers/types.js'

const zone: DnsZone = { id: 'zone-1', name: 'example.com' }

function providerFixture(records: DnsRecord[]): DnsProvider {
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
  it('recovers from reordered writes, delayed deletion, and delayed creation', async () => {
    const old: DnsRecord = { id: 'old', name: '@', type: 'A', value: '76.76.21.21' }
    const desired: DnsRecordInput = { name: '@', type: 'A', value: '203.0.113.10' }
    let records: DnsRecord[] = [old, desired]
    let writes = 0
    const provider = providerFixture(records)
    provider.listRecords = async () => records
    provider.planChanges = async (_zone, recordsToWrite, opts) =>
      planDnsChanges({ desired: recordsToWrite, existing: records, force: opts?.force, providerId: 'test', zone })
    provider.applyChanges = async (_zone, plan) => {
      writes += 1
      records = []
      return { applied: plan.changes, skipped: [] }
    }
    let now = 0

    const result = await reconcileDesiredRecord({
      dependencies: {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
          if (writes > 0 && records.length === 0) records = [{ ...desired }]
        },
      },
      desired,
      force: true,
      intervalMs: 1,
      provider,
      settleMs: 1,
      timeoutMs: 1000,
      zone,
    })

    assert.equal(writes, 1)
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
        force: true,
        intervalMs: 1,
        provider,
        settleMs: 1,
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
        force: false,
        intervalMs: 1,
        provider,
        settleMs: 0,
        timeoutMs: 2,
        zone,
      }),
      (error: unknown) => error instanceof DoomainError && error.code === 'DNS_RECONCILIATION_INCOMPLETE',
    )
    assert.equal(plans, 0)
  })
})
