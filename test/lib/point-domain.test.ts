import { strict as assert } from 'node:assert'
import { describe, it } from 'mocha'

import { DoomainError } from '../../src/lib/errors.js'
import { createPointRecord, pointDomain } from '../../src/lib/point-domain.js'
import type { DnsChangePlan, DnsProvider, DnsRecordInput, DnsZone } from '../../src/lib/providers/types.js'

const zone: DnsZone = { id: 'zone-1', name: 'example.com' }

function providerWith(conflicts: DnsChangePlan['conflicts'] = []): DnsProvider {
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
    applyChanges: async (_zone, plan) => ({ applied: plan.changes, skipped: [] }),
    deleteRecord: async () => undefined,
    getZone: async () => zone,
    listRecords: async () => [],
    listZones: async () => [zone],
    planChanges: async (_zone, desired) => ({
      changes: [{ action: 'create', record: desired[0] }],
      conflicts,
      desired,
      existing: [],
      zone,
    }),
    upsertRecord: async (_zone, record) => record,
    verifyCredentials: async () => ({ ok: true }),
  }
}

describe('point domain', () => {
  it('infers address and canonical-name records', () => {
    assert.deepEqual(createPointRecord({ provider: 'spaceship', recordName: '@', target: '203.0.113.10', ttl: 300 }), {
      name: '@',
      ttl: 300,
      type: 'A',
      value: '203.0.113.10',
    })
    assert.deepEqual(
      createPointRecord({ provider: 'spaceship', recordName: 'app', target: 'origin.example.net.', ttl: 600 }),
      {
        name: 'app',
        ttl: 600,
        type: 'CNAME',
        value: 'origin.example.net',
      },
    )
    assert.deepEqual(createPointRecord({ provider: 'spaceship', recordName: 'ipv6', target: '2001:db8::10' }), {
      name: 'ipv6',
      ttl: 300,
      type: 'AAAA',
      value: '2001:db8::10',
    })
  })

  it('rejects malformed canonical hostname targets', () => {
    assert.throws(
      () => createPointRecord({ provider: 'spaceship', recordName: 'app', target: 'not a hostname' }),
      (error: unknown) => error instanceof DoomainError && error.code === 'INVALID_INPUT',
    )
  })

  it('rejects an apex CNAME when the provider does not support it', async () => {
    await assert.rejects(
      pointDomain(
        { domain: 'example.com', dryRun: true, target: 'origin.example.net' },
        {
          createProvider: async () => providerWith(),
          resolveTarget: async () => ({
            account: 'default',
            accountInferred: true,
            isDefaultAccount: true,
            provider: 'test',
            providerInferred: true,
            target: { fullDomain: 'example.com', isApex: true, recordName: '@', zoneDomain: 'example.com' },
            warnings: [],
          }),
        },
      ),
      (error: unknown) => error instanceof DoomainError && error.code === 'PROVIDER_UNSUPPORTED_RECORD',
    )
  })

  it('previews without inspecting or writing records during a dry run', async () => {
    let applied = false
    let planned = false
    const provider = providerWith()
    provider.planChanges = async () => {
      planned = true
      throw new Error('Dry runs must not inspect current records')
    }
    provider.applyChanges = async () => {
      applied = true
      return { applied: [], skipped: [] }
    }

    const result = await pointDomain(
      { domain: 'app.example.com', dryRun: true, target: '203.0.113.10' },
      {
        createProvider: async () => provider,
        resolveTarget: async () => ({
          account: 'default',
          accountInferred: true,
          isDefaultAccount: true,
          provider: 'test',
          providerInferred: true,
          target: { fullDomain: 'app.example.com', isApex: false, recordName: 'app', zoneDomain: 'example.com' },
          warnings: [],
        }),
      },
    )

    assert.equal(applied, false)
    assert.equal(planned, false)
    assert.equal(result.dryRun, true)
    assert.equal(result.record.type, 'A')
    assert.equal(result.record.name, 'app')
  })

  it('refuses conflicting records unless force is explicit', async () => {
    const desired: DnsRecordInput = { name: '@', type: 'A', value: '203.0.113.10' }
    const provider = providerWith([
      {
        existing: { name: '@', type: 'A', value: '192.0.2.1' },
        reason: 'different value',
        record: desired,
      },
    ])

    await assert.rejects(
      pointDomain(
        { domain: 'example.com', target: '203.0.113.10' },
        {
          createProvider: async () => provider,
          resolveTarget: async () => ({
            account: 'default',
            accountInferred: true,
            isDefaultAccount: true,
            provider: 'test',
            providerInferred: true,
            target: { fullDomain: 'example.com', isApex: true, recordName: '@', zoneDomain: 'example.com' },
            warnings: [],
          }),
        },
      ),
      (error: unknown) => error instanceof DoomainError && error.code === 'DNS_TARGET_CONFLICT',
    )
  })

  it('returns a successful write with propagated false when waiting times out', async () => {
    let checks = 0
    const result = await pointDomain(
      { domain: 'app.example.com', target: '203.0.113.10', timeoutSeconds: 0 },
      {
        createProvider: async () => providerWith(),
        resolve4: async () => {
          checks += 1
          return []
        },
        resolveTarget: async () => ({
          account: 'default',
          accountInferred: true,
          isDefaultAccount: true,
          provider: 'test',
          providerInferred: true,
          target: { fullDomain: 'app.example.com', isApex: false, recordName: 'app', zoneDomain: 'example.com' },
          warnings: [],
        }),
      },
    )

    assert.equal(checks, 1)
    assert.equal(result.updated, true)
    assert.equal(result.propagated, false)
  })

  it('recognizes equivalent IPv6 forms during propagation checks', async () => {
    const result = await pointDomain(
      { domain: 'ipv6.example.com', target: '2001:db8::10', timeoutSeconds: 0 },
      {
        createProvider: async () => providerWith(),
        resolve6: async () => ['2001:0db8:0000:0000:0000:0000:0000:0010'],
        resolveTarget: async () => ({
          account: 'default',
          accountInferred: true,
          isDefaultAccount: true,
          provider: 'test',
          providerInferred: true,
          target: { fullDomain: 'ipv6.example.com', isApex: false, recordName: 'ipv6', zoneDomain: 'example.com' },
          warnings: [],
        }),
      },
    )

    assert.equal(result.propagated, true)
  })
})
