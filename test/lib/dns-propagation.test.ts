import { strict as assert } from 'node:assert'
import { describe, it } from 'mocha'

import { classifyDnsPropagation, observeDnsRecord } from '../../src/lib/dns-propagation.js'
import { runEffect } from '../helpers/effect.js'

describe('DNS propagation classification', () => {
  it('preserves native resolver error codes in observations', async () => {
    const [observation] = await runEffect(
      observeDnsRecord('app.example.com', { type: 'A', value: '203.0.113.10' }, [
        { kind: 'public', name: 'invalid', servers: ['not-an-ip-address'] },
      ]),
    )

    assert.equal(observation?.errorCode, 'ERR_INVALID_IP_ADDRESS')
  })

  it('does not call a failed system lookup a stale local cache', () => {
    assert.equal(
      classifyDnsPropagation([
        {
          answers: [],
          elapsedMs: 0,
          error: 'resolver unavailable',
          kind: 'system',
          matches: false,
          resolver: 'system',
          servers: ['100.64.0.2'],
          type: 'A',
        },
        {
          answers: [{ ttl: 300, value: '203.0.113.10' }],
          elapsedMs: 0,
          kind: 'public',
          matches: true,
          resolver: 'cloudflare',
          servers: ['1.1.1.1'],
          type: 'A',
        },
      ]),
      'system_resolver_unavailable',
    )
  })

  it('classifies mixed system answers as a stale local cache', () => {
    assert.equal(
      classifyDnsPropagation([
        {
          answers: [
            { ttl: 300, value: '203.0.113.10' },
            { ttl: 2200, value: '76.76.21.21' },
          ],
          elapsedMs: 0,
          kind: 'system',
          matches: false,
          resolver: 'system',
          servers: ['100.64.0.2'],
          type: 'A',
        },
        {
          answers: [{ ttl: 300, value: '203.0.113.10' }],
          elapsedMs: 0,
          kind: 'public',
          matches: true,
          resolver: 'cloudflare',
          servers: ['1.1.1.1'],
          type: 'A',
        },
      ]),
      'local_or_vpn_cache_stale',
    )
  })

  it('counts cached negative public answers as propagation pending', () => {
    assert.equal(
      classifyDnsPropagation([
        {
          answers: [{ ttl: 300, value: '203.0.113.10' }],
          elapsedMs: 0,
          kind: 'system',
          matches: true,
          resolver: 'system',
          servers: ['192.0.2.53'],
          type: 'A',
        },
        {
          answers: [],
          elapsedMs: 0,
          error: 'queryA ENOTFOUND app.example.com',
          errorCode: 'ENOTFOUND',
          kind: 'public',
          matches: false,
          resolver: 'cloudflare',
          servers: ['1.1.1.1'],
          type: 'A',
        },
        {
          answers: [{ ttl: 300, value: '203.0.113.10' }],
          elapsedMs: 0,
          kind: 'public',
          matches: true,
          resolver: 'google',
          servers: ['8.8.8.8'],
          type: 'A',
        },
      ]),
      'public_propagation_pending',
    )
  })

  it('classifies a cached negative system answer as a stale local cache', () => {
    assert.equal(
      classifyDnsPropagation([
        {
          answers: [],
          elapsedMs: 0,
          error: 'queryA ENOTFOUND app.example.com',
          errorCode: 'ENOTFOUND',
          kind: 'system',
          matches: false,
          resolver: 'system',
          servers: ['192.0.2.53'],
          type: 'A',
        },
        {
          answers: [{ ttl: 300, value: '203.0.113.10' }],
          elapsedMs: 0,
          kind: 'public',
          matches: true,
          resolver: 'cloudflare',
          servers: ['1.1.1.1'],
          type: 'A',
        },
      ]),
      'local_or_vpn_cache_stale',
    )
  })
})
