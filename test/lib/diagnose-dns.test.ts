import { strict as assert } from 'node:assert'
import { Effect } from 'effect'
import { describe, it } from 'mocha'

import {
  type DiagnoseDnsInput,
  diagnoseDns as diagnoseDnsEffect,
  type MacOsResolverMetadata,
} from '../../src/lib/diagnose-dns.js'
import type { DnsResolverObservation } from '../../src/lib/dns-propagation.js'
import type { ResolvedDnsTarget } from '../../src/lib/domain-provider.js'
import { DoomainError } from '../../src/lib/errors.js'
import type { DnsRecord, DnsRecordInput, DnsZone } from '../../src/lib/providers/types.js'
import { effectFromPromise, effectProvider, type PromiseDnsProvider, runEffect } from '../helpers/effect.js'

interface TestDependencies {
  createProvider: (provider: string, opts: { account?: string }) => Promise<PromiseDnsProvider>
  macOsResolvers?: () => Promise<MacOsResolverMetadata[]>
  observeDns: (
    fqdn: string,
    target: Pick<DnsRecordInput, 'type' | 'value'>,
    elapsedMs: number,
  ) => Promise<DnsResolverObservation[]>
  resolveTarget: (input: Pick<DiagnoseDnsInput, 'account' | 'domain' | 'provider'>) => Promise<ResolvedDnsTarget>
}

const diagnoseDns = (input: DiagnoseDnsInput, dependencies?: TestDependencies) =>
  runEffect(
    diagnoseDnsEffect(
      input,
      dependencies
        ? {
            createProvider: (provider, opts) =>
              effectFromPromise(() => dependencies.createProvider(provider, opts)).pipe(Effect.map(effectProvider)),
            macOsResolvers: dependencies.macOsResolvers
              ? () =>
                  effectFromPromise(() => dependencies.macOsResolvers?.() ?? Promise.resolve([])).pipe(
                    Effect.catchAll(() => Effect.succeed([])),
                  )
              : undefined,
            observeDns: (fqdn, target, elapsedMs) =>
              effectFromPromise(() => dependencies.observeDns(fqdn, target, elapsedMs)),
            resolveTarget: (targetInput) => effectFromPromise(() => dependencies.resolveTarget(targetInput)),
          }
        : undefined,
    ),
  )

const zone: DnsZone = { id: 'zone-1', name: 'example.com' }

function providerWith(records: DnsRecord[]): PromiseDnsProvider {
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
    planChanges: async () => ({ changes: [], conflicts: [], desired: [], existing: records, zone }),
    upsertRecord: async (_zone, record) => record,
    verifyCredentials: async () => ({ ok: true }),
  }
}

const resolved = {
  account: 'personal',
  accountInferred: true,
  isDefaultAccount: false,
  provider: 'test',
  providerInferred: true,
  target: { fullDomain: 'example.com', isApex: true, recordName: '@', zoneDomain: 'example.com' },
  warnings: [],
}

describe('diagnose DNS', () => {
  it('identifies stale local/VPN DNS while public DNS and provider state agree', async () => {
    const provider = providerWith([{ name: '@', ttl: 300, type: 'A', value: '203.0.113.10' }])
    const result = await diagnoseDns(
      { domain: 'example.com', target: '203.0.113.10' },
      {
        createProvider: async () => provider,
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
        resolveTarget: async () => resolved,
      },
    )

    assert.equal(result.status, 'local_or_vpn_cache_stale')
    assert.equal(result.observations[0].answers[0].ttl, 2200)
    assert.deepEqual(
      result.systemResolverServers,
      result.systemResolverServers.filter((server) => typeof server === 'string'),
    )
  })

  it('reports provider_not_updated and address-slot conflicts before blaming propagation', async () => {
    const provider = providerWith([
      { name: '@', type: 'A', value: '76.76.21.21' },
      { name: '@', type: 'A', value: '192.0.2.1' },
      { name: '@', type: 'CNAME', value: 'origin.example.net' },
      { name: '@', priority: 10, type: 'MX', value: 'mail.example.net' },
    ])
    const result = await diagnoseDns(
      { domain: 'example.com', target: '203.0.113.10' },
      {
        createProvider: async () => provider,
        observeDns: async () => [],
        resolveTarget: async () => resolved,
      },
    )

    assert.equal(result.status, 'provider_not_updated')
    assert.deepEqual(result.conflicts.map((conflict) => conflict.reason).sort(), [
      'cname_slot_conflict',
      'multiple_values',
    ])
    assert.equal(
      result.conflicts
        .find((conflict) => conflict.reason === 'cname_slot_conflict')
        ?.records.some((record) => record.type === 'MX'),
      true,
    )
  })

  it('returns diagnosis-specific recovery commands when provider resolution fails', async () => {
    await assert.rejects(
      diagnoseDns(
        {
          domain: 'app.example.com',
          provider: 'spaceship',
          recordType: 'CNAME',
          target: 'origin.example.net',
        },
        {
          createProvider: async () => providerWith([]),
          observeDns: async () => [],
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
        return (
          details.recovery.includes(
            'doomain dns diagnose app.example.com --provider spaceship --type CNAME --target origin.example.net --json',
          ) &&
          details.suggestedCommands.includes(
            'doomain dns diagnose app.example.com --provider spaceship --type CNAME --target origin.example.net --json',
          ) &&
          !details.suggestedCommands.some((command) => command.startsWith('doomain link'))
        )
      },
    )
  })

  it('reports consistent absence when provider and resolvers have no record', async () => {
    const provider = providerWith([])
    const result = await diagnoseDns(
      { domain: 'example.com' },
      {
        createProvider: async () => provider,
        observeDns: async (_fqdn, target, elapsedMs) =>
          [
            { kind: 'system' as const, resolver: 'system', servers: ['192.0.2.53'] },
            { kind: 'public' as const, resolver: 'cloudflare', servers: ['1.1.1.1'] },
            { kind: 'public' as const, resolver: 'google', servers: ['8.8.8.8'] },
          ].map((resolver) => ({
            ...resolver,
            answers: [],
            elapsedMs,
            error: 'queryA ENOTFOUND example.com',
            errorCode: 'ENOTFOUND',
            expected: target.value,
            matches: false,
            type: target.type,
          })),
        resolveTarget: async () => resolved,
      },
    )

    assert.equal(result.status, 'consistent')
    assert.equal(
      result.observations.every((observation) => observation.matches),
      true,
    )
  })

  it('rejects a missing resolved provider zone', async () => {
    const provider = providerWith([])
    provider.getZone = async () => null

    await assert.rejects(
      diagnoseDns(
        { domain: 'example.com' },
        {
          createProvider: async () => provider,
          observeDns: async () => [],
          resolveTarget: async () => resolved,
        },
      ),
      (error: unknown) => error instanceof DoomainError && error.code === 'PROVIDER_ZONE_NOT_FOUND',
    )
  })

  for (const input of [
    { domain: 'example.com', recordType: 'A' as const, target: 'origin.example.net' },
    { domain: 'example.com', recordType: 'CNAME' as const, target: '203.0.113.10' },
  ]) {
    it(`rejects incompatible ${input.recordType} diagnosis target ${input.target}`, async () => {
      await assert.rejects(
        diagnoseDns(input, {
          createProvider: async () => providerWith([]),
          observeDns: async () => [],
          resolveTarget: async () => resolved,
        }),
        (error: unknown) => error instanceof DoomainError && error.code === 'INVALID_INPUT',
      )
    })
  }
})
