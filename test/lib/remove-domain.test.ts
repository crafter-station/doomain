import { strict as assert } from 'node:assert'
import { describe, it } from 'mocha'

import { DoomainError } from '../../src/lib/errors.js'
import type { DnsProvider, DnsRecord, DnsZone } from '../../src/lib/providers/types.js'
import { removeDomain } from '../../src/lib/remove-domain.js'

const zone: DnsZone = { id: 'zone-1', name: 'example.com' }

function providerWith(initial: DnsRecord[]): { provider: DnsProvider; records: () => DnsRecord[] } {
  let records = [...initial]
  const provider: DnsProvider = {
    id: 'test',
    name: 'Test DNS',
    capabilities: {
      defaultTtl: 300,
      recordTypes: ['A', 'AAAA', 'CNAME', 'MX', 'TXT'],
      supportsApexCname: false,
      supportsBulkWrites: true,
      supportsPagination: false,
      supportsProxying: false,
      supportsRecordIds: true,
    },
    applyChanges: async (_zone, plan) => {
      for (const change of plan.changes) {
        if (change.action === 'delete') records = records.filter((record) => record !== change.existing)
      }
      return { applied: plan.changes, skipped: [] }
    },
    deleteRecord: async () => undefined,
    getZone: async () => zone,
    listRecords: async () => records,
    listZones: async () => [zone],
    planChanges: async () => ({ changes: [], conflicts: [], desired: [], existing: records, zone }),
    upsertRecord: async (_zone, record) => record,
    verifyCredentials: async () => ({ ok: true }),
  }
  return { provider, records: () => records }
}

const resolved = {
  account: 'default',
  accountInferred: true,
  isDefaultAccount: true,
  provider: 'test',
  providerInferred: true,
  target: { fullDomain: 'app.example.com', isApex: false, recordName: 'app', zoneDomain: 'example.com' },
  warnings: [],
}

describe('remove domain', () => {
  it('deletes only the exact name, type, and value and verifies absence', async () => {
    const fixture = providerWith([
      { name: 'app', type: 'A', value: '203.0.113.10' },
      { name: 'app', type: 'A', value: '192.0.2.1' },
      { name: 'other', type: 'A', value: '203.0.113.10' },
    ])

    const result = await removeDomain(
      { domain: 'app.example.com', recordType: 'A', value: '203.0.113.10' },
      { createProvider: async () => fixture.provider, resolveTarget: async () => resolved },
    )

    assert.equal(result.removed, 1)
    assert.equal(result.reconciled, true)
    assert.deepEqual(fixture.records(), [
      { name: 'app', type: 'A', value: '192.0.2.1' },
      { name: 'other', type: 'A', value: '203.0.113.10' },
    ])
  })

  it('rejects ambiguous duplicate matches without explicit all-matching approval', async () => {
    const fixture = providerWith([
      { id: '1', name: 'app', type: 'A', value: '203.0.113.10' },
      { id: '2', name: 'app', type: 'A', value: '203.0.113.10' },
    ])

    await assert.rejects(
      removeDomain(
        { domain: 'app.example.com', recordType: 'A', value: '203.0.113.10' },
        { createProvider: async () => fixture.provider, resolveTarget: async () => resolved },
      ),
      (error: unknown) => error instanceof DoomainError && error.code === 'DNS_DELETE_AMBIGUOUS',
    )
    assert.equal(fixture.records().length, 2)
  })

  it('dry-runs all matching records without deleting any', async () => {
    const fixture = providerWith([
      { name: 'app', type: 'A', value: '203.0.113.10' },
      { name: 'app', type: 'A', value: '192.0.2.1' },
    ])

    const result = await removeDomain(
      { allMatching: true, domain: 'app.example.com', dryRun: true, recordType: 'A' },
      { createProvider: async () => fixture.provider, resolveTarget: async () => resolved },
    )

    assert.equal(result.matched.length, 2)
    assert.equal(result.removed, 0)
    assert.equal(result.reconciled, false)
    assert.equal(fixture.records().length, 2)
  })

  it('matches TXT values exactly without case folding or stripping trailing periods', async () => {
    const fixture = providerWith([
      { id: '1', name: '_proof', type: 'TXT', value: 'CaseSensitive.' },
      { id: '2', name: '_proof', type: 'TXT', value: 'casesensitive' },
    ])

    const result = await removeDomain(
      { domain: 'app.example.com', recordType: 'TXT', value: 'CaseSensitive.' },
      {
        createProvider: async () => fixture.provider,
        resolveTarget: async () => ({
          ...resolved,
          target: { ...resolved.target, recordName: '_proof' },
        }),
      },
    )

    assert.equal(result.removed, 1)
    assert.deepEqual(fixture.records(), [{ id: '2', name: '_proof', type: 'TXT', value: 'casesensitive' }])
  })

  it('does not expand a reviewed deletion plan to a concurrently created record', async () => {
    const planned: DnsRecord = { id: 'planned', name: 'app', type: 'A', value: '203.0.113.10' }
    const concurrent: DnsRecord = { id: 'concurrent', name: 'app', type: 'A', value: '203.0.113.10' }
    const fixture = providerWith([planned])
    let writes = 0
    fixture.provider.applyChanges = async (_zone, plan) => {
      writes += 1
      if (writes === 1) {
        const records = fixture.records()
        records.splice(0, records.length, concurrent)
      }
      return { applied: plan.changes, skipped: [] }
    }

    await assert.rejects(
      removeDomain(
        {
          domain: 'app.example.com',
          reconcileTimeoutSeconds: 0,
          recordType: 'A',
          value: planned.value,
        },
        { createProvider: async () => fixture.provider, resolveTarget: async () => resolved },
      ),
      (error: unknown) => error instanceof DoomainError && error.code === 'DNS_RECONCILIATION_INCOMPLETE',
    )
    assert.equal(writes, 1)
    assert.deepEqual(fixture.records(), [concurrent])
  })

  it('returns removal-specific recovery commands when provider resolution fails', async () => {
    await assert.rejects(
      removeDomain(
        {
          account: 'work',
          domain: 'app.example.com',
          provider: 'spaceship',
          recordType: 'A',
          value: '203.0.113.10',
        },
        {
          createProvider: async () => providerWith([]).provider,
          resolveTarget: async () => {
            throw new DoomainError('PROVIDER_ZONE_NOT_FOUND', 'No matching zone.', {
              suggestedCommands: ['doomain link app.example.com --json'],
            })
          },
        },
      ),
      (error: unknown) => {
        if (!(error instanceof DoomainError)) return false
        const details = error.details as { recovery: string; suggestedCommands: string[] }
        const retry =
          'doomain dns remove app.example.com --provider spaceship --account work --type A --value 203.0.113.10 --json'
        return (
          details.recovery.includes(retry) &&
          details.suggestedCommands.includes(retry) &&
          !details.suggestedCommands.some((command) => command.startsWith('doomain link'))
        )
      },
    )
  })
})
