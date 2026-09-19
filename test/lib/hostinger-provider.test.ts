import { expect } from 'chai'

import { createProvider } from '../../src/lib/providers/registry.js'

function jsonResponse(body: unknown): Response {
  return { json: async () => body, ok: true, status: 200 } as Response
}

describe('hostinger provider', () => {
  const originalFetch = globalThis.fetch
  const env = { ...process.env }

  beforeEach(() => {
    process.env.HOSTINGER_API_TOKEN = 'hostinger_token'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env = { ...env }
  })

  it('lists Hostinger domains from the portfolio API', async () => {
    const authorizations: Array<string | null> = []
    globalThis.fetch = (async (_input, init) => {
      const headers = new Headers(init?.headers)
      authorizations.push(headers.get('authorization'))
      return jsonResponse([
        { domain: 'Example.COM', id: 1, status: 'active' },
        { domain: 'pending.com', id: 2, status: 'pending_setup' },
        { domain: null, id: 3, status: 'pending_setup' },
      ])
    }) as typeof fetch

    const provider = await createProvider('hostinger')
    const zones = await provider.listZones()

    expect(authorizations).to.deep.equal(['Bearer hostinger_token'])
    expect(zones).to.deep.equal([
      {
        id: 'example.com',
        metadata: { hostinger: { domain: 'Example.COM', id: 1, status: 'active' } },
        name: 'example.com',
      },
    ])
  })

  it('lists DNS records from grouped Hostinger zone records', async () => {
    globalThis.fetch = (async () =>
      jsonResponse([
        { name: '@', records: [{ content: '76.76.21.21', is_disabled: false }], ttl: 14_400, type: 'A' },
        { name: 'app', records: [{ content: 'cname.vercel-dns.com', is_disabled: false }], ttl: 3600, type: 'CNAME' },
        {
          name: 'example.com.',
          records: [{ content: 'vc-domain-verify=example.com,abc' }, { content: 'disabled-record', is_disabled: true }],
          ttl: 3600,
          type: 'TXT',
        },
        { name: 'alias', records: [{ content: 'unsupported.example.com' }], ttl: 3600, type: 'ALIAS' },
      ])) as typeof fetch

    const provider = await createProvider('hostinger')
    const records = await provider.listRecords({ id: 'example.com', name: 'example.com' })

    expect(records).to.deep.equal([
      {
        metadata: {
          hostinger: { name: '@', records: [{ content: '76.76.21.21', is_disabled: false }], ttl: 14_400, type: 'A' },
        },
        name: '@',
        ttl: 14_400,
        type: 'A',
        value: '76.76.21.21',
      },
      {
        metadata: {
          hostinger: {
            name: 'app',
            records: [{ content: 'cname.vercel-dns.com', is_disabled: false }],
            ttl: 3600,
            type: 'CNAME',
          },
        },
        name: 'app',
        ttl: 3600,
        type: 'CNAME',
        value: 'cname.vercel-dns.com',
      },
      {
        metadata: {
          hostinger: {
            name: 'example.com.',
            records: [{ content: 'vc-domain-verify=example.com,abc' }],
            ttl: 3600,
            type: 'TXT',
          },
        },
        name: '@',
        ttl: 3600,
        type: 'TXT',
        value: 'vc-domain-verify=example.com,abc',
      },
    ])
  })

  it('creates DNS records without overwriting existing Hostinger values', async () => {
    const requests: Array<{ init?: RequestInit; input: RequestInfo | URL }> = []
    globalThis.fetch = (async (input, init) => {
      requests.push({ init, input })
      return jsonResponse([])
    }) as typeof fetch

    const provider = await createProvider('hostinger')
    const zone = { id: 'example.com', name: 'example.com' }
    const plan = await provider.planChanges(zone, [
      { name: 'app', ttl: 3600, type: 'CNAME', value: 'cname.vercel-dns.com' },
    ])
    await provider.applyChanges(zone, plan)

    const updateRequest = requests.find((request) => request.init?.method === 'PUT')!
    expect(String(updateRequest.input)).to.equal('https://developers.hostinger.com/api/dns/v1/zones/example.com')
    expect(JSON.parse(String(updateRequest.init?.body))).to.deep.equal({
      overwrite: false,
      zone: [{ name: 'app', records: [{ content: 'cname.vercel-dns.com' }], ttl: 3600, type: 'CNAME' }],
    })
  })

  it('overwrites matching Hostinger record sets for forced updates', async () => {
    const requests: Array<{ init?: RequestInit; input: RequestInfo | URL }> = []
    globalThis.fetch = (async (input, init) => {
      requests.push({ init, input })
      const method = init?.method ?? 'GET'
      return jsonResponse(
        method === 'GET'
          ? [{ name: 'app', records: [{ content: 'old.example.com' }], ttl: 3600, type: 'CNAME' }]
          : { message: 'Request accepted' },
      )
    }) as typeof fetch

    const provider = await createProvider('hostinger')
    const zone = { id: 'example.com', name: 'example.com' }
    const plan = await provider.planChanges(
      zone,
      [{ name: 'app', ttl: 3600, type: 'CNAME', value: 'cname.vercel-dns.com' }],
      { force: true },
    )
    await provider.applyChanges(zone, plan)

    const updateRequest = requests.find((request) => request.init?.method === 'PUT')!
    expect(JSON.parse(String(updateRequest.init?.body))).to.deep.equal({
      overwrite: true,
      zone: [{ name: 'app', records: [{ content: 'cname.vercel-dns.com' }], ttl: 3600, type: 'CNAME' }],
    })
  })

  it('replaces a multi-value Hostinger record set without deleting the replacement', async () => {
    const requests: Array<{ init?: RequestInit; input: RequestInfo | URL }> = []
    globalThis.fetch = (async (input, init) => {
      requests.push({ init, input })
      const method = init?.method ?? 'GET'
      return jsonResponse(
        method === 'GET'
          ? [
              {
                name: 'app',
                records: [{ content: '192.0.2.1' }, { content: '192.0.2.2' }],
                ttl: 3600,
                type: 'A',
              },
            ]
          : { message: 'Request accepted' },
      )
    }) as typeof fetch

    const provider = await createProvider('hostinger')
    const zone = { id: 'example.com', name: 'example.com' }
    const plan = await provider.planChanges(zone, [{ name: 'app', ttl: 300, type: 'A', value: '203.0.113.10' }], {
      force: true,
    })
    await provider.applyChanges(zone, plan)

    expect(requests.filter((request) => request.init?.method === 'DELETE')).to.deep.equal([])
    const updateRequests = requests.filter((request) => request.init?.method === 'PUT')
    expect(updateRequests).to.have.length(1)
    expect(JSON.parse(String(updateRequests[0].init?.body))).to.deep.equal({
      overwrite: true,
      zone: [{ name: 'app', records: [{ content: '203.0.113.10' }], ttl: 300, type: 'A' }],
    })
  })

  it('removes stale Hostinger values while preserving an exact desired value', async () => {
    const requests: Array<{ init?: RequestInit; input: RequestInfo | URL }> = []
    globalThis.fetch = (async (input, init) => {
      requests.push({ init, input })
      const method = init?.method ?? 'GET'
      return jsonResponse(
        method === 'GET'
          ? [
              {
                name: 'app',
                records: [{ content: '203.0.113.10' }, { content: '192.0.2.1' }],
                ttl: 300,
                type: 'A',
              },
            ]
          : { message: 'Request accepted' },
      )
    }) as typeof fetch

    const provider = await createProvider('hostinger')
    const zone = { id: 'example.com', name: 'example.com' }
    const desired = { name: 'app', ttl: 300, type: 'A' as const, value: '203.0.113.10' }
    const plan = await provider.planChanges(zone, [desired], { force: true })
    await provider.applyChanges(zone, plan)

    expect(requests.filter((request) => request.init?.method === 'DELETE')).to.deep.equal([])
    const updateRequests = requests.filter((request) => request.init?.method === 'PUT')
    expect(updateRequests).to.have.length(1)
    expect(JSON.parse(String(updateRequests[0].init?.body))).to.deep.equal({
      overwrite: true,
      zone: [{ name: 'app', records: [{ content: '203.0.113.10' }], ttl: 300, type: 'A' }],
    })
  })

  it('deletes Hostinger records by name and type filter', async () => {
    const requests: Array<{ init?: RequestInit; input: RequestInfo | URL }> = []
    globalThis.fetch = (async (input, init) => {
      requests.push({ init, input })
      return jsonResponse({ message: 'Request accepted' })
    }) as typeof fetch

    const provider = await createProvider('hostinger')
    await provider.deleteRecord(
      { id: 'example.com', name: 'example.com' },
      { name: 'app', type: 'CNAME', value: 'old.example.com' },
    )

    expect(String(requests[0].input)).to.equal('https://developers.hostinger.com/api/dns/v1/zones/example.com')
    expect(requests[0].init?.method).to.equal('DELETE')
    expect(JSON.parse(String(requests[0].init?.body))).to.deep.equal({ filters: [{ name: 'app', type: 'CNAME' }] })
  })

  it('preserves sibling values when applying an exact-value deletion plan', async () => {
    const requests: Array<{ init?: RequestInit; input: RequestInfo | URL }> = []
    globalThis.fetch = (async (input, init) => {
      requests.push({ init, input })
      return jsonResponse({ message: 'Request accepted' })
    }) as typeof fetch

    const provider = await createProvider('hostinger')
    const zone = { id: 'example.com', name: 'example.com' }
    const removed = { name: 'app', ttl: 300, type: 'A' as const, value: '203.0.113.10' }
    const preserved = { name: 'app', ttl: 300, type: 'A' as const, value: '192.0.2.1' }
    const alsoPreserved = { name: 'app', ttl: 300, type: 'A' as const, value: '192.0.2.2' }
    await provider.applyChanges(zone, {
      changes: [{ action: 'delete', existing: removed }],
      conflicts: [],
      desired: [],
      existing: [removed, preserved, alsoPreserved],
      zone,
    })

    expect(requests.filter((request) => request.init?.method === 'DELETE')).to.deep.equal([])
    expect(requests).to.have.length(1)
    expect(requests[0].init?.method).to.equal('PUT')
    expect(JSON.parse(String(requests[0].init?.body))).to.deep.equal({
      overwrite: true,
      zone: [
        {
          name: 'app',
          records: [{ content: '192.0.2.1' }, { content: '192.0.2.2' }],
          ttl: 300,
          type: 'A',
        },
      ],
    })
  })
})
