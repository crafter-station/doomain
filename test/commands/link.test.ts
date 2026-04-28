import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {runCommand} from '@oclif/test'
import {expect} from 'chai'

import {DmlinkError} from '../../src/lib/errors.js'
import {linkDomain, verificationRecords} from '../../src/lib/link-domain.js'

function jsonResponse(body: unknown): Response {
  return {json: async () => body, ok: true, status: 200} as Response
}

function textResponse(body: string): Response {
  return {ok: true, status: 200, text: async () => body} as Response
}

function cloudflareResponse(result: unknown) {
  return {errors: [], messages: [], result, 'result_info': {page: 1, 'total_pages': 1}, success: true}
}

function namecheapDomainListXml(domains: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ApiResponse Status="OK">
  <CommandResponse>
    <DomainGetListResult>
      ${domains.map((domain) => `<Domain Name="${domain}" />`).join('\n      ')}
    </DomainGetListResult>
    <Paging TotalItems="${domains.length}" />
  </CommandResponse>
</ApiResponse>`
}

describe('link', () => {
  const originalFetch = globalThis.fetch
  const env = {...process.env}
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dmlink-link-'))
    process.env = {...env, DMLINK_CONFIG_FILE: join(dir, 'config.json')}
    for (const key of [
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
      'DMLINK_DOMAIN',
      'DMLINK_PROVIDER',
      'NAMECHEAP_API_KEY',
      'NAMECHEAP_API_USER',
      'NAMECHEAP_CLIENT_IP',
      'NAMECHEAP_USERNAME',
      'SPACESHIP_API_KEY',
      'SPACESHIP_API_SECRET',
      'VERCEL_TEAM_ID',
      'VERCEL_TOKEN',
    ]) {
      delete process.env[key]
    }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env = {...env}
    rmSync(dir, {force: true, recursive: true})
  })

  it('prints a dry-run JSON plan for an explicit provider', async () => {
    process.env.SPACESHIP_API_KEY = 'key'
    process.env.SPACESHIP_API_SECRET = 'secret'
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))
      if (url.hostname === 'spaceship.dev' && url.pathname === '/api/v1/domains') {
        return jsonResponse({items: [{name: 'example.com'}], total: 1})
      }

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const {stdout} = await runCommand(
      'link --provider spaceship --domain example.com --subdomain app --project prj_123 --dry-run --json',
    )
    const result = JSON.parse(stdout) as {
      ok: boolean
      data: {
        domain: string
        dryRun: boolean
        provider: string
        providerInferred: boolean
        recordName: string
        records: Array<{type: string; name: string; value: string}>
      }
    }

    expect(result.ok).to.equal(true)
    expect(result.data.dryRun).to.equal(true)
    expect(result.data.domain).to.equal('app.example.com')
    expect(result.data.provider).to.equal('spaceship')
    expect(result.data.providerInferred).to.equal(false)
    expect(result.data.recordName).to.equal('app')
    expect(result.data.records).to.deep.equal([{type: 'CNAME', name: 'app', value: 'cname.vercel-dns.com', ttl: 3600}])
  })

  it('accepts the target domain as a positional argument', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cloudflare_token'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account_123'
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))
      if (url.hostname === 'api.cloudflare.com' && url.pathname === '/client/v4/zones') {
        return jsonResponse(cloudflareResponse([{id: 'zone_1', name: 'example.com'}]))
      }

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const {stdout} = await runCommand('link app.example.com --project prj_123 --dry-run --json')
    const result = JSON.parse(stdout) as {ok: boolean; data: {domain: string; provider: string; recordName: string}}

    expect(result.ok).to.equal(true)
    expect(result.data.domain).to.equal('app.example.com')
    expect(result.data.provider).to.equal('cloudflare')
    expect(result.data.recordName).to.equal('app')
  })

  it('infers Namecheap provider and zone from a full target domain', async () => {
    process.env.NAMECHEAP_API_USER = 'user'
    process.env.NAMECHEAP_API_KEY = 'key'
    process.env.NAMECHEAP_CLIENT_IP = '127.0.0.1'
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))
      if (url.hostname === 'api.namecheap.com') return textResponse(namecheapDomainListXml(['text0.dev']))
      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const result = await linkDomain({domain: 'dev.text0.dev', dryRun: true, project: 'text0'})

    expect(result.provider).to.equal('namecheap')
    expect(result.providerInferred).to.equal(true)
    expect(result.zoneDomain).to.equal('text0.dev')
    expect(result.domain).to.equal('dev.text0.dev')
    expect(result.recordName).to.equal('dev')
    expect(result.records).to.deep.equal([{name: 'dev', ttl: 3600, type: 'CNAME', value: 'cname.vercel-dns.com'}])
  })

  it('uses the longest matching configured zone', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cloudflare_token'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account_123'
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))
      if (url.hostname === 'api.cloudflare.com' && url.pathname === '/client/v4/zones') {
        return jsonResponse(
          cloudflareResponse([
            {id: 'zone_1', name: 'example.com'},
            {id: 'zone_2', name: 'dev.example.com'},
          ]),
        )
      }

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const result = await linkDomain({domain: 'api.dev.example.com', dryRun: true, project: 'prj_123'})

    expect(result.provider).to.equal('cloudflare')
    expect(result.zoneDomain).to.equal('dev.example.com')
    expect(result.recordName).to.equal('api')
    expect(result.records).to.deep.equal([
      {name: 'api', proxied: false, ttl: 3600, type: 'CNAME', value: 'cname.vercel-dns.com'},
    ])
  })

  it('treats an exact target-zone match as apex when no subdomain is provided', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cloudflare_token'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account_123'
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))
      if (url.hostname === 'api.cloudflare.com' && url.pathname === '/client/v4/zones') {
        return jsonResponse(cloudflareResponse([{id: 'zone_1', name: 'example.com'}]))
      }

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const result = await linkDomain({domain: 'example.com', dryRun: true, project: 'prj_123'})

    expect(result.isApex).to.equal(true)
    expect(result.recordName).to.equal('@')
    expect(result.records).to.deep.equal([{name: '@', proxied: false, ttl: 3600, type: 'A', value: '76.76.21.21'}])
  })

  it('reports ambiguous zone ownership across providers', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cloudflare_token'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account_123'
    process.env.NAMECHEAP_API_USER = 'user'
    process.env.NAMECHEAP_API_KEY = 'key'
    process.env.NAMECHEAP_CLIENT_IP = '127.0.0.1'
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))
      if (url.hostname === 'api.cloudflare.com' && url.pathname === '/client/v4/zones') {
        return jsonResponse(cloudflareResponse([{id: 'zone_1', name: 'example.com'}]))
      }

      if (url.hostname === 'api.namecheap.com') return textResponse(namecheapDomainListXml(['example.com']))
      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    let error: unknown
    try {
      await linkDomain({domain: 'app.example.com', dryRun: true, project: 'prj_123'})
    } catch (error_) {
      error = error_
    }

    expect(error).to.be.instanceOf(DmlinkError)
    expect((error as DmlinkError).code).to.equal('PROVIDER_ZONE_AMBIGUOUS')
    expect((error as DmlinkError).details).to.deep.equal({
      candidates: [
        {provider: 'namecheap', providerName: 'Namecheap', zoneDomain: 'example.com'},
        {provider: 'cloudflare', providerName: 'Cloudflare', zoneDomain: 'example.com'},
      ],
      domain: 'app.example.com',
    })
  })

  it('extracts Vercel ownership TXT verification records', () => {
    const records = verificationRecords(
      {
        verification: [
          {
            domain: '_vercel.cueva.io',
            type: 'TXT',
            value: 'vc-domain-verify=onpe.cueva.io,b827cb82107d3b3a8324',
          },
        ],
      },
      'cueva.io',
    )

    expect(records).to.deep.equal([
      {
        name: '_vercel',
        ttl: 3600,
        type: 'TXT',
        value: 'vc-domain-verify=onpe.cueva.io,b827cb82107d3b3a8324',
      },
    ])
  })

  it('uses Vercel verification without blocking on public DNS propagation', async () => {
    const dnsBodies: Array<Record<string, unknown>> = []
    const requests: string[] = []
    process.env.VERCEL_TOKEN = 'vercel_token'
    process.env.CLOUDFLARE_API_TOKEN = 'cloudflare_token'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account_123'

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      requests.push(`${method} ${url.pathname}`)

      if (url.hostname === 'api.vercel.com') {
        if (method === 'POST' && url.pathname === '/v10/projects/prj_123/domains') return jsonResponse({name: 'app.example.com'})
        if (method === 'GET' && url.pathname === '/v6/domains/app.example.com/config') {
          return jsonResponse({recommendedCNAME: [{rank: 1, value: 'cname.vercel-dns.com.'}]})
        }

        if (method === 'GET' && url.pathname === '/v9/projects/prj_123/domains/app.example.com') {
          return jsonResponse({
            name: 'app.example.com',
            verified: false,
            verification: [
              {
                domain: '_vercel.example.com',
                type: 'TXT',
                value: 'vc-domain-verify=app.example.com,token',
              },
            ],
          })
        }

        if (method === 'POST' && url.pathname === '/v9/projects/prj_123/domains/app.example.com/verify') {
          return jsonResponse({name: 'app.example.com', verified: true})
        }
      }

      if (url.hostname === 'api.cloudflare.com') {
        if (method === 'GET' && url.pathname === '/client/v4/zones') {
          return jsonResponse(cloudflareResponse([{id: 'zone_1', name: 'example.com'}]))
        }

        if (method === 'GET' && url.pathname === '/client/v4/zones/zone_1/dns_records') {
          return jsonResponse(cloudflareResponse([]))
        }

        if (method === 'POST' && url.pathname === '/client/v4/zones/zone_1/dns_records') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          dnsBodies.push(body)
          return jsonResponse(cloudflareResponse({...body, id: `record_${dnsBodies.length}`}))
        }
      }

      throw new Error(`Unexpected request: ${method} ${url.href}`)
    }) as typeof fetch

    const result = await linkDomain({
      domain: 'example.com',
      project: 'prj_123',
      provider: 'cloudflare',
      subdomain: 'app',
      timeoutSeconds: 1,
      wait: true,
    })

    expect(result.vercel.verified).to.equal(true)
    expect(requests).to.include('POST /v9/projects/prj_123/domains/app.example.com/verify')
    expect(dnsBodies).to.deep.include({content: 'vc-domain-verify=app.example.com,token', name: '_vercel.example.com', ttl: 3600, type: 'TXT'})
  })
})
