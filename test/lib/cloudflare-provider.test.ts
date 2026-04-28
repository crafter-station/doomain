import {expect} from 'chai'

import {createProvider} from '../../src/lib/providers/registry.js'

function cloudflareResponse<T>(result: T, resultInfo: Record<string, unknown> = {}) {
  return {errors: [], messages: [], result, 'result_info': resultInfo, success: true}
}

function jsonResponse(body: unknown): Response {
  return {json: async () => body, ok: true, status: 200} as Response
}

describe('cloudflare provider', () => {
  const originalFetch = globalThis.fetch
  const env = {...process.env}

  beforeEach(() => {
    process.env.CLOUDFLARE_API_TOKEN = 'token'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account_123'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env = {...env}
  })

  it('lists Cloudflare zones with pagination', async () => {
    const pages: string[] = []
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))
      pages.push(url.searchParams.get('page') ?? '')

      return jsonResponse(
        url.searchParams.get('page') === '1'
          ? cloudflareResponse([{id: 'zone_1', name: 'example.com'}], {page: 1, 'total_pages': 2})
          : cloudflareResponse([{id: 'zone_2', name: 'example.org'}], {page: 2, 'total_pages': 2}),
      )
    }) as typeof fetch

    const provider = await createProvider('cloudflare')
    const zones = await provider.listZones()

    expect(pages).to.deep.equal(['1', '2'])
    expect(zones).to.deep.equal([
      {id: 'zone_1', metadata: {cloudflare: {id: 'zone_1', name: 'example.com'}}, name: 'example.com'},
      {id: 'zone_2', metadata: {cloudflare: {id: 'zone_2', name: 'example.org'}}, name: 'example.org'},
    ])
  })

  it('lists DNS records with relative names', async () => {
    globalThis.fetch = (async () =>
      jsonResponse(
        cloudflareResponse(
          [
            {content: '76.76.21.21', id: 'record_1', name: 'example.com', proxied: false, ttl: 3600, type: 'A'},
            {content: 'cname.vercel-dns.com', id: 'record_2', name: 'app.example.com', proxied: false, ttl: 3600, type: 'CNAME'},
            {content: 'did=did:plc:123', id: 'record_3', name: '_atproto.example.com', ttl: 3600, type: 'TXT'},
          ],
          {page: 1, 'total_pages': 1},
        ),
      )) as typeof fetch

    const provider = await createProvider('cloudflare')
    const records = await provider.listRecords({id: 'zone_1', name: 'example.com'})

    expect(records).to.deep.equal([
      {
        id: 'record_1',
        metadata: {cloudflare: {content: '76.76.21.21', id: 'record_1', name: 'example.com', proxied: false, ttl: 3600, type: 'A'}},
        name: '@',
        proxied: false,
        ttl: 3600,
        type: 'A',
        value: '76.76.21.21',
      },
      {
        id: 'record_2',
        metadata: {
          cloudflare: {
            content: 'cname.vercel-dns.com',
            id: 'record_2',
            name: 'app.example.com',
            proxied: false,
            ttl: 3600,
            type: 'CNAME',
          },
        },
        name: 'app',
        proxied: false,
        ttl: 3600,
        type: 'CNAME',
        value: 'cname.vercel-dns.com',
      },
      {
        id: 'record_3',
        metadata: {cloudflare: {content: 'did=did:plc:123', id: 'record_3', name: '_atproto.example.com', ttl: 3600, type: 'TXT'}},
        name: '_atproto',
        ttl: 3600,
        type: 'TXT',
        value: 'did=did:plc:123',
      },
    ])
  })

  it('creates DNS records with full Cloudflare names', async () => {
    const requests: Array<{init?: RequestInit; input: RequestInfo | URL}> = []
    globalThis.fetch = (async (input, init) => {
      requests.push({init, input})
      const method = init?.method ?? 'GET'
      return jsonResponse(
        method === 'POST'
          ? cloudflareResponse({content: 'cname.vercel-dns.com', id: 'record_1', name: 'app.example.com', proxied: false, ttl: 3600, type: 'CNAME'})
          : cloudflareResponse([], {page: 1, 'total_pages': 1}),
      )
    }) as typeof fetch

    const provider = await createProvider('cloudflare')
    const zone = {id: 'zone_1', name: 'example.com'}
    const plan = await provider.planChanges(zone, [{name: 'app', proxied: false, ttl: 3600, type: 'CNAME', value: 'cname.vercel-dns.com'}])
    await provider.applyChanges(zone, plan)

    const createRequest = requests.find((request) => request.init?.method === 'POST')!
    expect(String(createRequest.input)).to.equal('https://api.cloudflare.com/client/v4/zones/zone_1/dns_records')
    expect(JSON.parse(String(createRequest.init?.body))).to.deep.equal({
      content: 'cname.vercel-dns.com',
      name: 'app.example.com',
      proxied: false,
      ttl: 3600,
      type: 'CNAME',
    })
  })

  it('updates DNS records by record id', async () => {
    const requests: Array<{init?: RequestInit; input: RequestInfo | URL}> = []
    globalThis.fetch = (async (input, init) => {
      requests.push({init, input})
      const method = init?.method ?? 'GET'
      return jsonResponse(
        method === 'PUT'
          ? cloudflareResponse({content: 'cname.vercel-dns.com', id: 'record_1', name: 'app.example.com', proxied: false, ttl: 3600, type: 'CNAME'})
          : cloudflareResponse(
              [{content: 'cname.vercel-dns.com', id: 'record_1', name: 'app.example.com', proxied: true, ttl: 3600, type: 'CNAME'}],
              {page: 1, 'total_pages': 1},
            ),
      )
    }) as typeof fetch

    const provider = await createProvider('cloudflare')
    const zone = {id: 'zone_1', name: 'example.com'}
    const plan = await provider.planChanges(zone, [{name: 'app', proxied: false, ttl: 3600, type: 'CNAME', value: 'cname.vercel-dns.com'}])
    await provider.applyChanges(zone, plan)

    const updateRequest = requests.find((request) => request.init?.method === 'PUT')!
    expect(String(updateRequest.input)).to.equal('https://api.cloudflare.com/client/v4/zones/zone_1/dns_records/record_1')
    expect(JSON.parse(String(updateRequest.init?.body)).proxied).to.equal(false)
  })

  it('deletes DNS records by record id', async () => {
    const requests: Array<{init?: RequestInit; input: RequestInfo | URL}> = []
    globalThis.fetch = (async (input, init) => {
      requests.push({init, input})
      return jsonResponse(cloudflareResponse({id: 'record_1'}))
    }) as typeof fetch

    const provider = await createProvider('cloudflare')
    await provider.deleteRecord({id: 'zone_1', name: 'example.com'}, {id: 'record_1', name: 'app', type: 'CNAME', value: 'old.example.com'})

    expect(String(requests[0].input)).to.equal('https://api.cloudflare.com/client/v4/zones/zone_1/dns_records/record_1')
    expect(requests[0].init?.method).to.equal('DELETE')
  })

  it('throws Cloudflare API error messages', async () => {
    globalThis.fetch = (async () => jsonResponse({errors: [{code: 1000, message: 'Token lacks DNS permissions'}], messages: [], success: false})) as typeof fetch

    const provider = await createProvider('cloudflare')
    let error: unknown

    try {
      await provider.listZones()
    } catch (error_) {
      error = error_
    }

    expect(error).to.be.instanceOf(Error)
    expect((error as Error).message).to.equal('Token lacks DNS permissions')
  })
})
