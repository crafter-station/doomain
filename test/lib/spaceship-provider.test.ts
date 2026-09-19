import { expect } from 'chai'

import { createProvider } from '../../src/lib/providers/registry.js'
import { promiseProvider, runEffect } from '../helpers/effect.js'

describe('spaceship provider', () => {
  const originalFetch = globalThis.fetch
  const originalApiKey = process.env.SPACESHIP_API_KEY
  const originalApiSecret = process.env.SPACESHIP_API_SECRET

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalApiKey === undefined) delete process.env.SPACESHIP_API_KEY
    else process.env.SPACESHIP_API_KEY = originalApiKey
    if (originalApiSecret === undefined) delete process.env.SPACESHIP_API_SECRET
    else process.env.SPACESHIP_API_SECRET = originalApiSecret
  })

  it('lists Spaceship domains from the paginated API', async () => {
    process.env.SPACESHIP_API_KEY = 'key'
    process.env.SPACESHIP_API_SECRET = 'secret'
    const requestedSkips: string[] = []

    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))
      const skip = url.searchParams.get('skip') ?? '0'
      requestedSkips.push(skip)

      return {
        ok: true,
        status: 200,
        json: async () =>
          skip === '0'
            ? { items: [{ name: 'alpha.com' }, { unicodeName: 'beta.com' }], total: 3 }
            : { items: [{ name: 'gamma.com' }], total: 3 },
      } as Response
    }) as typeof fetch

    const provider = promiseProvider(await runEffect(createProvider('spaceship')))
    const zones = await provider.listZones()

    expect(requestedSkips).to.deep.equal(['0', '2'])
    expect(zones).to.deep.equal([
      { id: 'alpha.com', name: 'alpha.com' },
      { id: 'beta.com', name: 'beta.com' },
      { id: 'gamma.com', name: 'gamma.com' },
    ])
  })

  it('deletes every replaced value before creating the desired value', async () => {
    process.env.SPACESHIP_API_KEY = 'key'
    process.env.SPACESHIP_API_SECRET = 'secret'
    const requests: Array<{ body: unknown; method: string }> = []

    globalThis.fetch = (async (_input, init) => {
      requests.push({ body: JSON.parse(String(init?.body)), method: init?.method ?? 'GET' })
      return { json: async () => ({}), ok: true, status: 200 } as Response
    }) as typeof fetch

    const provider = promiseProvider(await runEffect(createProvider('spaceship')))
    const zone = { id: 'example.com', name: 'example.com' }
    await provider.applyChanges(zone, {
      changes: [
        {
          action: 'update',
          existing: { name: '@', ttl: 300, type: 'A', value: '76.76.21.21' },
          record: { name: '@', ttl: 300, type: 'A', value: '203.0.113.10' },
        },
        {
          action: 'delete',
          existing: { name: '@', ttl: 300, type: 'A', value: '192.0.2.1' },
        },
      ],
      conflicts: [],
      desired: [{ name: '@', ttl: 300, type: 'A', value: '203.0.113.10' }],
      existing: [
        { name: '@', ttl: 300, type: 'A', value: '76.76.21.21' },
        { name: '@', ttl: 300, type: 'A', value: '192.0.2.1' },
      ],
      zone,
    })

    expect(requests.map((request) => request.method)).to.deep.equal(['DELETE', 'DELETE', 'PUT'])
    expect(requests[2].body).to.deep.equal({
      force: true,
      items: [{ address: '203.0.113.10', name: '@', ttl: 300, type: 'A' }],
    })
  })
})
