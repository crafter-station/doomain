import { strict as assert } from 'node:assert'
import { Effect } from 'effect'
import { describe, it } from 'mocha'

import type { DnsResolverObservation } from '../../src/lib/dns-propagation.js'
import type { ResolvedDnsTarget } from '../../src/lib/domain-provider.js'
import { DoomainError } from '../../src/lib/errors.js'
import {
  createPointRecord,
  type PointDomainInput,
  pointDomain as pointDomainEffect,
} from '../../src/lib/point-domain.js'
import { planDnsChanges } from '../../src/lib/providers/core/planner.js'
import type { DnsChangePlan, DnsRecord, DnsRecordInput, DnsZone } from '../../src/lib/providers/types.js'
import { effectFromPromise, effectProvider, type PromiseDnsProvider, runEffect } from '../helpers/effect.js'

interface TestDependencies {
  createProvider: (provider: string, opts: { account?: string }) => Promise<PromiseDnsProvider>
  observeDns?: (
    fqdn: string,
    target: Pick<DnsRecordInput, 'type' | 'value'>,
    elapsedMs: number,
  ) => Promise<DnsResolverObservation[]>
  resolveTarget: (input: Pick<PointDomainInput, 'account' | 'domain' | 'provider'>) => Promise<ResolvedDnsTarget>
}

const pointDomain = (input: PointDomainInput, dependencies?: TestDependencies) =>
  runEffect(
    pointDomainEffect(
      input,
      dependencies
        ? {
            createProvider: (provider, opts) =>
              effectFromPromise(() => dependencies.createProvider(provider, opts)).pipe(Effect.map(effectProvider)),
            observeDns: dependencies.observeDns
              ? (fqdn, target, elapsedMs) =>
                  effectFromPromise(() => dependencies.observeDns?.(fqdn, target, elapsedMs) ?? Promise.resolve([]))
              : undefined,
            resolveTarget: (targetInput) => effectFromPromise(() => dependencies.resolveTarget(targetInput)),
          }
        : undefined,
    ),
  )

const zone: DnsZone = { id: 'zone-1', name: 'example.com' }

function providerWith(conflicts: DnsChangePlan['conflicts'] = []): PromiseDnsProvider {
  let records: DnsChangePlan['existing'] = []
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
    applyChanges: async (_zone, plan) => {
      for (const change of plan.changes) {
        if (change.action === 'delete') records = records.filter((record) => record !== change.existing)
        if (change.action === 'create') records.push({ ...change.record })
        if (change.action === 'update') {
          records = records.filter((record) => record !== change.existing)
          records.push({ ...change.record })
        }
      }
      return { applied: plan.changes, skipped: [] }
    },
    deleteRecord: async () => undefined,
    getZone: async () => zone,
    listRecords: async () => records,
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

  it('rejects TTLs outside the selected provider range', async () => {
    const provider = providerWith()
    provider.capabilities.minTtl = 60
    provider.capabilities.maxTtl = 86_400

    await assert.rejects(
      pointDomain(
        { domain: 'app.example.com', dryRun: true, target: '203.0.113.10', ttl: 30 },
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
      ),
      (error: unknown) =>
        error instanceof DoomainError &&
        error.code === 'INVALID_INPUT' &&
        error.message === 'Test DNS requires a TTL between 60 and 86400 seconds.',
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
        observeDns: async (_fqdn, target, elapsedMs) => {
          checks += 1
          return [
            {
              answers: [],
              elapsedMs,
              expected: target.value,
              kind: 'public',
              matches: false,
              resolver: 'cloudflare',
              servers: ['1.1.1.1'],
              type: target.type,
            },
          ]
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
    assert.equal(result.propagation.status, 'public_propagation_pending')
    assert.equal(result.propagation.timeoutReason, 'public_resolvers_did_not_match_before_timeout')
  })

  it('recognizes equivalent IPv6 forms during propagation checks', async () => {
    const result = await pointDomain(
      { domain: 'ipv6.example.com', target: '2001:db8::10', timeoutSeconds: 0 },
      {
        createProvider: async () => providerWith(),
        observeDns: async (_fqdn, target, elapsedMs) => [
          {
            answers: [{ ttl: 300, value: '2001:0db8:0000:0000:0000:0000:0000:0010' }],
            elapsedMs,
            expected: target.value,
            kind: 'public',
            matches: true,
            resolver: 'cloudflare',
            servers: ['1.1.1.1'],
            type: target.type,
          },
        ],
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

  it('reconciles a forced replacement after stale provider reads leave both values visible', async () => {
    const desired: DnsRecordInput = { name: '@', ttl: 300, type: 'A', value: '203.0.113.10' }
    const old = { name: '@', ttl: 300, type: 'A' as const, value: '76.76.21.21' }
    let records: DnsRecord[] = [old]
    let writes = 0
    let reconciliationReads = 0
    const provider = providerWith()
    provider.listRecords = async () => {
      reconciliationReads += 1
      const observed = records
      if (reconciliationReads === 1 && writes > 0) records = [{ ...desired }]
      return observed
    }
    provider.planChanges = async (_zone, recordsToWrite, opts) =>
      planDnsChanges({ desired: recordsToWrite, existing: records, force: opts?.force, providerId: 'test', zone })
    provider.applyChanges = async (_zone, plan) => {
      writes += 1
      records = [old, { ...desired }]
      return { applied: plan.changes, skipped: [] }
    }

    const result = await pointDomain(
      { domain: 'example.com', force: true, target: desired.value, wait: false },
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
    )

    assert.equal(writes, 1)
    assert.equal(result.reconciled, true)
    assert.equal(result.reconciliationAttempts, 2)
    assert.deepEqual(records, [desired])
  })

  it('fails closed with observed records when provider reconciliation times out', async () => {
    const provider = providerWith()
    provider.listRecords = async () => [{ name: 'app', type: 'A', value: '192.0.2.1' }]

    await assert.rejects(
      pointDomain(
        {
          domain: 'app.example.com',
          force: true,
          reconcileTimeoutSeconds: 0,
          target: '203.0.113.10',
          wait: false,
        },
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
      ),
      (error: unknown) => {
        if (!(error instanceof DoomainError) || error.code !== 'DNS_RECONCILIATION_INCOMPLETE') return false
        const details = error.details as { observed: Array<{ value: string }> }
        return details.observed[0].value === '192.0.2.1'
      },
    )
  })

  it('identifies a stale system or VPN cache when public resolvers already match', async () => {
    const result = await pointDomain(
      { domain: 'app.example.com', target: '203.0.113.10', timeoutSeconds: 0 },
      {
        createProvider: async () => providerWith(),
        observeDns: async (_fqdn, target, elapsedMs) => [
          {
            answers: [{ ttl: 2200, value: '76.76.21.21' }],
            elapsedMs,
            expected: target.value,
            kind: 'system',
            matches: false,
            resolver: 'system',
            servers: ['100.64.0.2'],
            type: target.type,
          },
          {
            answers: [{ ttl: 300, value: target.value }],
            elapsedMs,
            expected: target.value,
            kind: 'public',
            matches: true,
            resolver: 'cloudflare',
            servers: ['1.1.1.1'],
            type: target.type,
          },
        ],
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

    assert.equal(result.propagated, true)
    assert.equal(result.propagation.status, 'local_or_vpn_cache_stale')
    assert.equal(result.propagation.observations[0].answers[0].ttl, 2200)
  })
})
