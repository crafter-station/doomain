import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {runCommand} from '@oclif/test'
import {expect} from 'chai'

import {DoomainError} from '../../src/lib/errors.js'
import {linkDomain, verificationRecords} from '../../src/lib/link-domain.js'
import {saveConfig} from '../../src/lib/config.js'
import {createVercelClient} from '../../src/lib/vercel.js'

function jsonResponse(body: unknown): Response {
  return {json: async () => body, ok: true, status: 200} as Response
}

function jsonErrorResponse(status: number, body: unknown): Response {
  return {json: async () => body, ok: false, status} as Response
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
  const cwd = process.cwd()
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'doomain-link-'))
    process.env = {...env, DOOMAIN_CONFIG_FILE: join(dir, 'config.json')}
    for (const key of [
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
      'DOOMAIN_DOMAIN',
      'DOOMAIN_PROVIDER',
      'HOSTINGER_API_TOKEN',
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
    process.chdir(cwd)
    rmSync(dir, {force: true, recursive: true})
  })

  it('requires an explicit domain for the link command', async () => {
    const {stdout} = await runCommand('link --json')
    const result = JSON.parse(stdout) as {error: {code: string; message: string}; ok: boolean}

    expect(result.ok).to.equal(false)
    expect(result.error.code).to.equal('MISSING_ARGUMENT')
    expect(result.error.message).to.include('doomain link <domain>')
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

  it('infers the Vercel project from the nearest package.json name', async () => {
    process.env.VERCEL_TOKEN = 'vercel_token'
    process.env.SPACESHIP_API_KEY = 'key'
    process.env.SPACESHIP_API_SECRET = 'secret'
    writeFileSync(join(dir, 'package.json'), JSON.stringify({name: 'crafter-survey'}))
    process.chdir(dir)

    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))
      if (url.hostname === 'api.vercel.com' && url.pathname === '/v9/projects') {
        expect(url.searchParams.get('search')).to.equal('crafter-survey')
        return jsonResponse({projects: [{id: 'prj_123', name: 'crafter-survey'}]})
      }

      if (url.hostname === 'spaceship.dev' && url.pathname === '/api/v1/domains') {
        return jsonResponse({items: [{name: 'crafter.ventures'}], total: 1})
      }

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const {stdout} = await runCommand('link survey.crafter.ventures --dry-run --json')
    const result = JSON.parse(stdout) as {
      ok: boolean
      data: {domain: string; project: string; projectSource: string; provider: string; zoneDomain: string}
    }

    expect(result.ok).to.equal(true)
    expect(result.data.domain).to.equal('survey.crafter.ventures')
    expect(result.data.project).to.equal('crafter-survey')
    expect(result.data.projectSource).to.equal('packageJson')
    expect(result.data.provider).to.equal('spaceship')
    expect(result.data.zoneDomain).to.equal('crafter.ventures')
  })

  it('suggests Vercel projects when package.json project inference misses', async () => {
    process.env.VERCEL_TOKEN = 'vercel_token'
    writeFileSync(join(dir, 'package.json'), JSON.stringify({name: 'crafter-survey'}))
    process.chdir(dir)

    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))
      if (url.hostname === 'api.vercel.com' && url.pathname === '/v9/projects') {
        const search = url.searchParams.get('search')
        if (search === 'crafter-survey') return jsonResponse({projects: []})
        if (!search) {
          return jsonResponse({
            projects: [
              {id: 'prj_1', name: 'crafter-survey-prod'},
              {id: 'prj_2', name: 'survey'},
              {id: 'prj_3', name: 'unrelated'},
            ],
          })
        }
      }

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const {stdout} = await runCommand('link survey.crafter.ventures --dry-run --json')
    const result = JSON.parse(stdout) as {
      error: {code: string; details: {project: string; projectSource: string; suggestions: Array<{id: string; name: string}>}}
      ok: boolean
    }

    expect(result.ok).to.equal(false)
    expect(result.error.code).to.equal('VERCEL_PROJECT_NOT_LINKED')
    expect(result.error.details.project).to.equal('crafter-survey')
    expect(result.error.details.projectSource).to.equal('packageJson')
    expect(result.error.details.suggestions).to.deep.equal([
      {id: 'prj_1', name: 'crafter-survey-prod'},
      {id: 'prj_2', name: 'survey'},
    ])
  })

  it('uses DOOMAIN_PROJECT before package.json inference', async () => {
    process.env.DOOMAIN_PROJECT = 'env-project'
    process.env.SPACESHIP_API_KEY = 'key'
    process.env.SPACESHIP_API_SECRET = 'secret'
    writeFileSync(join(dir, 'package.json'), JSON.stringify({name: 'package-project'}))
    process.chdir(dir)

    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))
      if (url.hostname === 'spaceship.dev' && url.pathname === '/api/v1/domains') {
        return jsonResponse({items: [{name: 'example.com'}], total: 1})
      }

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const result = await linkDomain({domain: 'app.example.com', dryRun: true})

    expect(result.project).to.equal('env-project')
    expect(result.projectSource).to.equal('env')
  })

  it('uses configured default project when no project flag is provided', async () => {
    process.env.SPACESHIP_API_KEY = 'key'
    process.env.SPACESHIP_API_SECRET = 'secret'
    await saveConfig({defaults: {project: 'configured-project'}})

    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))
      if (url.hostname === 'spaceship.dev' && url.pathname === '/api/v1/domains') {
        return jsonResponse({items: [{name: 'example.com'}], total: 1})
      }

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const result = await linkDomain({domain: 'app.example.com', dryRun: true})

    expect(result.project).to.equal('configured-project')
    expect(result.projectSource).to.equal('config')
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

  it('uses a named provider account when linking with --account', async () => {
    await saveConfig({
      providers: {
        spaceship: {
          accounts: {work: {credentials: {apiKey: 'work_key', apiSecret: 'work_secret'}}},
          credentials: {apiKey: 'default_key', apiSecret: 'default_secret'},
        },
      },
    })

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const headers = init?.headers as Record<string, string>
      if (url.hostname === 'spaceship.dev' && url.pathname === '/api/v1/domains') {
        expect(headers['X-Api-Key']).to.equal('work_key')
        return jsonResponse({items: [{name: 'example.com'}], total: 1})
      }

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const result = await linkDomain({account: 'work', domain: 'app.example.com', dryRun: true, project: 'prj_123', provider: 'spaceship'})

    expect(result.provider).to.equal('spaceship')
    expect(result.account).to.equal('work')
    expect(result.accountInferred).to.equal(false)
    expect(result.isDefaultAccount).to.equal(false)
    expect(result.zoneDomain).to.equal('example.com')
  })

  it('reports ambiguous zone ownership across accounts for the same provider', async () => {
    await saveConfig({
      providers: {
        spaceship: {
          accounts: {work: {credentials: {apiKey: 'work_key', apiSecret: 'work_secret'}}},
          credentials: {apiKey: 'default_key', apiSecret: 'default_secret'},
        },
      },
    })

    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))
      if (url.hostname === 'spaceship.dev' && url.pathname === '/api/v1/domains') {
        return jsonResponse({items: [{name: 'example.com'}], total: 1})
      }

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    let error: unknown
    try {
      await linkDomain({domain: 'app.example.com', dryRun: true, project: 'prj_123', provider: 'spaceship'})
    } catch (error_) {
      error = error_
    }

    expect(error).to.be.instanceOf(DoomainError)
    expect((error as DoomainError).code).to.equal('PROVIDER_ZONE_AMBIGUOUS')
    expect((error as DoomainError).details).to.deep.equal({
      candidates: [
        {account: 'default', isDefaultAccount: true, provider: 'spaceship', providerName: 'Spaceship', zoneDomain: 'example.com'},
        {account: 'work', isDefaultAccount: false, provider: 'spaceship', providerName: 'Spaceship', zoneDomain: 'example.com'},
      ],
      domain: 'app.example.com',
    })
  })

  it('uses the longest matching zone across configured provider accounts', async () => {
    await saveConfig({
      providers: {
        spaceship: {
          accounts: {work: {credentials: {apiKey: 'work_key', apiSecret: 'work_secret'}}},
          credentials: {apiKey: 'default_key', apiSecret: 'default_secret'},
        },
      },
    })

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const headers = init?.headers as Record<string, string>
      if (url.hostname === 'spaceship.dev' && url.pathname === '/api/v1/domains') {
        return headers['X-Api-Key'] === 'work_key'
          ? jsonResponse({items: [{name: 'dev.example.com'}], total: 1})
          : jsonResponse({items: [{name: 'example.com'}], total: 1})
      }

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const result = await linkDomain({domain: 'api.dev.example.com', dryRun: true, project: 'prj_123'})

    expect(result.provider).to.equal('spaceship')
    expect(result.providerInferred).to.equal(true)
    expect(result.account).to.equal('work')
    expect(result.accountInferred).to.equal(true)
    expect(result.zoneDomain).to.equal('dev.example.com')
    expect(result.recordName).to.equal('api')
  })

  it('fails clearly when an explicit named provider account is missing credentials', async () => {
    await saveConfig({providers: {spaceship: {credentials: {apiKey: 'default_key', apiSecret: 'default_secret'}}}})

    let error: unknown
    try {
      await linkDomain({account: 'work', domain: 'app.example.com', dryRun: true, project: 'prj_123', provider: 'spaceship'})
    } catch (error_) {
      error = error_
    }

    expect(error).to.be.instanceOf(DoomainError)
    expect((error as DoomainError).code).to.equal('MISSING_CREDENTIALS')
    expect((error as DoomainError).details).to.deep.equal({account: 'work', provider: 'spaceship'})
  })

  it('treats legacy Spaceship credentials as the default account', async () => {
    await saveConfig({providers: {spaceship: {apiKey: 'legacy_key', apiSecret: 'legacy_secret'}}})

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const headers = init?.headers as Record<string, string>
      if (url.hostname === 'spaceship.dev' && url.pathname === '/api/v1/domains') {
        expect(headers['X-Api-Key']).to.equal('legacy_key')
        return jsonResponse({items: [{name: 'example.com'}], total: 1})
      }

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const result = await linkDomain({domain: 'app.example.com', dryRun: true, project: 'prj_123', provider: 'spaceship'})

    expect(result.account).to.equal('default')
    expect(result.isDefaultAccount).to.equal(true)
    expect(result.zoneDomain).to.equal('example.com')
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

    expect(error).to.be.instanceOf(DoomainError)
    expect((error as DoomainError).code).to.equal('PROVIDER_ZONE_AMBIGUOUS')
    expect((error as DoomainError).details).to.deep.equal({
      candidates: [
        {account: 'default', isDefaultAccount: true, provider: 'namecheap', providerName: 'Namecheap', zoneDomain: 'example.com'},
        {account: 'default', isDefaultAccount: true, provider: 'cloudflare', providerName: 'Cloudflare', zoneDomain: 'example.com'},
      ],
      domain: 'app.example.com',
    })
  })

  it('returns recovery details when no DNS provider is configured', async () => {
    let error: unknown
    try {
      await linkDomain({domain: 'app.example.com', dryRun: true, project: 'prj_123'})
    } catch (error_) {
      error = error_
    }

    expect(error).to.be.instanceOf(DoomainError)
    expect((error as DoomainError).code).to.equal('CONFIG_NOT_FOUND')
    expect((error as DoomainError).details).to.deep.include({
      recovery: 'Connect the DNS provider that owns this domain, then retry `doomain link <domain> --json`.',
      suggestedCommands: ['doomain providers connect', 'doomain link <domain> --json'],
    })
  })

  it('returns configured providers and searched zones when no zone matches', async () => {
    process.env.SPACESHIP_API_KEY = 'key'
    process.env.SPACESHIP_API_SECRET = 'secret'
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))
      if (url.hostname === 'spaceship.dev' && url.pathname === '/api/v1/domains') {
        return jsonResponse({items: [{name: 'other.dev'}], total: 1})
      }

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    let error: unknown
    try {
      await linkDomain({domain: 'app.example.com', dryRun: true, project: 'prj_123'})
    } catch (error_) {
      error = error_
    }

    expect(error).to.be.instanceOf(DoomainError)
    expect((error as DoomainError).code).to.equal('PROVIDER_ZONE_NOT_FOUND')
    expect((error as DoomainError).details).to.deep.include({
      domain: 'app.example.com',
      recovery:
        'Retry with --provider <id> --account <alias> only if another configured provider account owns this zone. Otherwise connect the DNS provider account that owns this domain.',
    })
    expect((error as DoomainError).details).to.deep.include({
      searchedZones: [{account: 'default', displayName: 'Spaceship', id: 'spaceship', isDefaultAccount: true, zones: ['other.dev']}],
    })
  })

  it('reports DNS target conflicts before adding the domain to Vercel in JSON mode', async () => {
    const requests: string[] = []
    process.env.VERCEL_TOKEN = 'vercel_token'
    process.env.CLOUDFLARE_API_TOKEN = 'cloudflare_token'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account_123'

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      requests.push(`${method} ${url.pathname}`)

      if (url.hostname === 'api.vercel.com') {
        if (method === 'GET' && url.pathname === '/v6/domains/app.example.com/config') return jsonResponse({})
        if (method === 'POST' && url.pathname === '/v10/projects/prj_123/domains') {
          return jsonResponse({name: 'app.example.com', verified: true})
        }
      }

      if (url.hostname === 'api.cloudflare.com') {
        if (method === 'GET' && url.pathname === '/client/v4/zones') return jsonResponse(cloudflareResponse([{id: 'zone_1', name: 'example.com'}]))
        if (method === 'GET' && url.pathname === '/client/v4/zones/zone_1/dns_records') {
          return jsonResponse(
            cloudflareResponse([{content: 'old.example.com', id: 'record_old', name: 'app.example.com', ttl: 3600, type: 'CNAME'}]),
          )
        }
      }

      throw new Error(`Unexpected request: ${method} ${url.href}`)
    }) as typeof fetch

    const {stdout} = await runCommand('link app.example.com --provider cloudflare --project prj_123 --json')
    const result = JSON.parse(stdout) as {
      error: {code: string; details: {conflicts: Array<{existing: {value: string}}>}}
      ok: boolean
    }

    expect(result.ok).to.equal(false)
    expect(result.error.code).to.equal('DNS_TARGET_CONFLICT')
    expect(result.error.details.conflicts[0].existing.value).to.equal('old.example.com')
    expect(requests).not.to.include('POST /v10/projects/prj_123/domains')
  })

  it('overwrites conflicting DNS records and continues when force is enabled', async () => {
    const requests: string[] = []
    const dnsBodies: Array<Record<string, unknown>> = []
    process.env.VERCEL_TOKEN = 'vercel_token'
    process.env.CLOUDFLARE_API_TOKEN = 'cloudflare_token'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account_123'

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      requests.push(`${method} ${url.pathname}`)

      if (url.hostname === 'api.vercel.com') {
        if (method === 'GET' && url.pathname === '/v6/domains/app.example.com/config') return jsonResponse({})
        if (method === 'POST' && url.pathname === '/v10/projects/prj_123/domains') return jsonResponse({name: 'app.example.com', verified: true})
        if (method === 'GET' && url.pathname === '/v9/projects/prj_123/domains/app.example.com') {
          return jsonResponse({name: 'app.example.com', verified: true})
        }
      }

      if (url.hostname === 'api.cloudflare.com') {
        if (method === 'GET' && url.pathname === '/client/v4/zones') return jsonResponse(cloudflareResponse([{id: 'zone_1', name: 'example.com'}]))
        if (method === 'GET' && url.pathname === '/client/v4/zones/zone_1/dns_records') {
          return jsonResponse(
            cloudflareResponse([{content: 'old.example.com', id: 'record_old', name: 'app.example.com', ttl: 3600, type: 'CNAME'}]),
          )
        }

        if (method === 'PUT' && url.pathname === '/client/v4/zones/zone_1/dns_records/record_old') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          dnsBodies.push(body)
          return jsonResponse(cloudflareResponse({...body, id: 'record_old'}))
        }
      }

      throw new Error(`Unexpected request: ${method} ${url.href}`)
    }) as typeof fetch

    const result = await linkDomain({domain: 'app.example.com', force: true, project: 'prj_123', provider: 'cloudflare', wait: false})

    expect(result.dns.updated).to.equal(true)
    expect(requests).to.include('POST /v10/projects/prj_123/domains')
    expect(dnsBodies).to.deep.equal([{content: 'cname.vercel-dns.com', name: 'app.example.com', proxied: false, ttl: 3600, type: 'CNAME'}])
  })

  it('uses confirmed DNS override for DNS writes without forcing Vercel moves', async () => {
    const requests: string[] = []
    const dnsBodies: Array<Record<string, unknown>> = []
    let confirmedDomain: string | undefined
    process.env.VERCEL_TOKEN = 'vercel_token'
    process.env.CLOUDFLARE_API_TOKEN = 'cloudflare_token'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account_123'

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      requests.push(`${method} ${url.pathname}`)

      if (url.hostname === 'api.vercel.com') {
        if (method === 'GET' && url.pathname === '/v6/domains/app.example.com/config') return jsonResponse({})
        if (method === 'POST' && url.pathname === '/v10/projects/prj_123/domains') return jsonResponse({name: 'app.example.com', verified: true})
        if (method === 'GET' && url.pathname === '/v9/projects/prj_123/domains/app.example.com') {
          return jsonResponse({name: 'app.example.com', verified: true})
        }
      }

      if (url.hostname === 'api.cloudflare.com') {
        if (method === 'GET' && url.pathname === '/client/v4/zones') return jsonResponse(cloudflareResponse([{id: 'zone_1', name: 'example.com'}]))
        if (method === 'GET' && url.pathname === '/client/v4/zones/zone_1/dns_records') {
          return jsonResponse(
            cloudflareResponse([{content: 'old.example.com', id: 'record_old', name: 'app.example.com', ttl: 3600, type: 'CNAME'}]),
          )
        }

        if (method === 'PUT' && url.pathname === '/client/v4/zones/zone_1/dns_records/record_old') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          dnsBodies.push(body)
          return jsonResponse(cloudflareResponse({...body, id: 'record_old'}))
        }
      }

      throw new Error(`Unexpected request: ${method} ${url.href}`)
    }) as typeof fetch

    const result = await linkDomain({
      confirmDnsOverride: async (warning) => {
        confirmedDomain = warning.domain
        return true
      },
      domain: 'app.example.com',
      project: 'prj_123',
      provider: 'cloudflare',
      wait: false,
    })

    expect(result.dns.updated).to.equal(true)
    expect(confirmedDomain).to.equal('app.example.com')
    expect(requests).to.include('POST /v10/projects/prj_123/domains')
    expect(requests).not.to.include('DELETE /v9/projects/prj_old/domains/app.example.com')
    expect(dnsBodies).to.have.length(1)
  })

  it('cancels a DNS override before Vercel or DNS writes', async () => {
    const requests: string[] = []
    process.env.VERCEL_TOKEN = 'vercel_token'
    process.env.CLOUDFLARE_API_TOKEN = 'cloudflare_token'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account_123'

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      requests.push(`${method} ${url.pathname}`)

      if (url.hostname === 'api.vercel.com') {
        if (method === 'GET' && url.pathname === '/v6/domains/app.example.com/config') return jsonResponse({})
        if (method === 'POST' && url.pathname === '/v10/projects/prj_123/domains') return jsonResponse({name: 'app.example.com', verified: true})
      }

      if (url.hostname === 'api.cloudflare.com') {
        if (method === 'GET' && url.pathname === '/client/v4/zones') return jsonResponse(cloudflareResponse([{id: 'zone_1', name: 'example.com'}]))
        if (method === 'GET' && url.pathname === '/client/v4/zones/zone_1/dns_records') {
          return jsonResponse(
            cloudflareResponse([{content: 'old.example.com', id: 'record_old', name: 'app.example.com', ttl: 3600, type: 'CNAME'}]),
          )
        }
      }

      throw new Error(`Unexpected request: ${method} ${url.href}`)
    }) as typeof fetch

    let error: unknown
    try {
      await linkDomain({confirmDnsOverride: async () => false, domain: 'app.example.com', project: 'prj_123', provider: 'cloudflare', wait: false})
    } catch (error_) {
      error = error_
    }

    expect(error).to.be.instanceOf(DoomainError)
    expect((error as DoomainError).code).to.equal('DNS_TARGET_CONFLICT')
    expect(requests).not.to.include('POST /v10/projects/prj_123/domains')
    expect(requests.some((request) => request.startsWith('PUT /client/v4/zones/zone_1/dns_records'))).to.equal(false)
  })

  it('does not prompt when the existing DNS target already matches Vercel', async () => {
    let prompted = false
    process.env.VERCEL_TOKEN = 'vercel_token'
    process.env.CLOUDFLARE_API_TOKEN = 'cloudflare_token'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account_123'

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'

      if (url.hostname === 'api.vercel.com') {
        if (method === 'GET' && url.pathname === '/v6/domains/app.example.com/config') return jsonResponse({})
        if (method === 'POST' && url.pathname === '/v10/projects/prj_123/domains') return jsonResponse({name: 'app.example.com', verified: true})
        if (method === 'GET' && url.pathname === '/v9/projects/prj_123/domains/app.example.com') {
          return jsonResponse({name: 'app.example.com', verified: true})
        }
      }

      if (url.hostname === 'api.cloudflare.com') {
        if (method === 'GET' && url.pathname === '/client/v4/zones') return jsonResponse(cloudflareResponse([{id: 'zone_1', name: 'example.com'}]))
        if (method === 'GET' && url.pathname === '/client/v4/zones/zone_1/dns_records') {
          return jsonResponse(
            cloudflareResponse([
              {content: 'cname.vercel-dns.com', id: 'record_existing', name: 'app.example.com', proxied: false, ttl: 3600, type: 'CNAME'},
            ]),
          )
        }
      }

      throw new Error(`Unexpected request: ${method} ${url.href}`)
    }) as typeof fetch

    const result = await linkDomain({
      confirmDnsOverride: async () => {
        prompted = true
        return false
      },
      domain: 'app.example.com',
      project: 'prj_123',
      provider: 'cloudflare',
      wait: false,
    })

    expect(result.dns.updated).to.equal(false)
    expect(prompted).to.equal(false)
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
    process.env.VERCEL_TEAM_ID = 'team_123'
    process.env.CLOUDFLARE_API_TOKEN = 'cloudflare_token'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account_123'

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      requests.push(`${method} ${url.pathname}`)

      if (url.hostname === 'api.vercel.com') {
        if (method === 'POST' && url.pathname === '/v10/projects/prj_123/domains') {
          expect(url.searchParams.get('teamId')).to.equal('team_123')
          expect(JSON.parse(String(init?.body))).to.deep.equal({name: 'app.example.com'})
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
        if (method === 'GET' && url.pathname === '/v6/domains/app.example.com/config') {
          return jsonResponse({misconfigured: false, recommendedCNAME: [{rank: 1, value: 'cname.vercel-dns.com.'}]})
        }

        if (method === 'GET' && url.pathname === '/v9/projects/prj_123/domains/app.example.com') {
          return jsonResponse({
            name: 'app.example.com',
            verified: false,
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
    expect(requests).to.include('POST /v10/projects/prj_123/domains')
    expect(requests).to.include('POST /v9/projects/prj_123/domains/app.example.com/verify')
    expect(dnsBodies).to.deep.include({content: 'vc-domain-verify=app.example.com,token', name: '_vercel.example.com', ttl: 3600, type: 'TXT'})
  })

  it('does not treat a Vercel verify response without verified true as verified', async () => {
    process.env.VERCEL_TOKEN = 'vercel_token'
    process.env.CLOUDFLARE_API_TOKEN = 'cloudflare_token'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account_123'

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'

      if (url.hostname === 'api.vercel.com') {
        if (method === 'POST' && url.pathname === '/v10/projects/prj_123/domains') return jsonResponse({name: 'app.example.com', verified: true})
        if (method === 'GET' && url.pathname === '/v6/domains/app.example.com/config') return jsonResponse({misconfigured: false})
        if (method === 'GET' && url.pathname === '/v9/projects/prj_123/domains/app.example.com') {
          return jsonResponse({name: 'app.example.com', verified: false})
        }

        if (method === 'POST' && url.pathname === '/v9/projects/prj_123/domains/app.example.com/verify') {
          return jsonResponse({name: 'app.example.com'})
        }
      }

      if (url.hostname === 'api.cloudflare.com') {
        if (method === 'GET' && url.pathname === '/client/v4/zones') return jsonResponse(cloudflareResponse([{id: 'zone_1', name: 'example.com'}]))
        if (method === 'GET' && url.pathname === '/client/v4/zones/zone_1/dns_records') return jsonResponse(cloudflareResponse([]))
        if (method === 'POST' && url.pathname === '/client/v4/zones/zone_1/dns_records') {
          return jsonResponse(cloudflareResponse({...JSON.parse(String(init?.body)), id: 'record_1'}))
        }
      }

      throw new Error(`Unexpected request: ${method} ${url.href}`)
    }) as typeof fetch

    const result = await linkDomain({domain: 'example.com', project: 'prj_123', provider: 'cloudflare', subdomain: 'app', timeoutSeconds: 0})

    expect(result.vercel.verified).to.equal(false)
  })

  it('fails when Vercel reports verified but domain config remains invalid', async () => {
    process.env.VERCEL_TOKEN = 'vercel_token'
    process.env.CLOUDFLARE_API_TOKEN = 'cloudflare_token'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account_123'

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'

      if (url.hostname === 'api.vercel.com') {
        if (method === 'POST' && url.pathname === '/v10/projects/prj_123/domains') return jsonResponse({name: 'app.example.com', verified: true})
        if (method === 'GET' && url.pathname === '/v6/domains/app.example.com/config') {
          return jsonResponse({conflicts: [{type: 'CNAME'}], misconfigured: true})
        }

        if (method === 'GET' && url.pathname === '/v9/projects/prj_123/domains/app.example.com') {
          return jsonResponse({name: 'app.example.com', verified: true})
        }

        if (method === 'POST' && url.pathname === '/v9/projects/prj_123/domains/app.example.com/verify') {
          return jsonResponse({name: 'app.example.com', verified: true})
        }
      }

      if (url.hostname === 'api.cloudflare.com') {
        if (method === 'GET' && url.pathname === '/client/v4/zones') return jsonResponse(cloudflareResponse([{id: 'zone_1', name: 'example.com'}]))
        if (method === 'GET' && url.pathname === '/client/v4/zones/zone_1/dns_records') return jsonResponse(cloudflareResponse([]))
        if (method === 'POST' && url.pathname === '/client/v4/zones/zone_1/dns_records') {
          return jsonResponse(cloudflareResponse({...JSON.parse(String(init?.body)), id: 'record_1'}))
        }
      }

      throw new Error(`Unexpected request: ${method} ${url.href}`)
    }) as typeof fetch

    let error: unknown
    try {
      await linkDomain({domain: 'example.com', project: 'prj_123', provider: 'cloudflare', subdomain: 'app', timeoutSeconds: 0})
    } catch (error_) {
      error = error_
    }

    expect(error).to.be.instanceOf(DoomainError)
    expect((error as DoomainError).code).to.equal('DOMAIN_VERIFY_FAILED')
    expect((error as DoomainError).details).to.deep.equal({domainConfig: {conflicts: [{type: 'CNAME'}], misconfigured: true}})
  })

  it('applies Vercel ownership TXT records returned from verify errors', async () => {
    const dnsBodies: Array<Record<string, unknown>> = []
    process.env.VERCEL_TOKEN = 'vercel_token'
    process.env.CLOUDFLARE_API_TOKEN = 'cloudflare_token'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account_123'

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'

      if (url.hostname === 'api.vercel.com') {
        if (method === 'POST' && url.pathname === '/v10/projects/prj_123/domains') return jsonResponse({name: 'app.example.com', verified: true})
        if (method === 'GET' && url.pathname === '/v6/domains/app.example.com/config') return jsonResponse({misconfigured: false})
        if (method === 'GET' && url.pathname === '/v9/projects/prj_123/domains/app.example.com') {
          return jsonResponse({name: 'app.example.com', verified: false})
        }

        if (method === 'POST' && url.pathname === '/v9/projects/prj_123/domains/app.example.com/verify') {
          return jsonErrorResponse(400, {
            error: {code: 'domain_verification_failed', message: 'Missing ownership verification.'},
            verification: [{domain: '_vercel.example.com', type: 'TXT', value: 'vc-domain-verify=app.example.com,late-token'}],
          })
        }
      }

      if (url.hostname === 'api.cloudflare.com') {
        if (method === 'GET' && url.pathname === '/client/v4/zones') return jsonResponse(cloudflareResponse([{id: 'zone_1', name: 'example.com'}]))
        if (method === 'GET' && url.pathname === '/client/v4/zones/zone_1/dns_records') return jsonResponse(cloudflareResponse([]))
        if (method === 'POST' && url.pathname === '/client/v4/zones/zone_1/dns_records') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          dnsBodies.push(body)
          return jsonResponse(cloudflareResponse({...body, id: `record_${dnsBodies.length}`}))
        }
      }

      throw new Error(`Unexpected request: ${method} ${url.href}`)
    }) as typeof fetch

    let error: unknown
    try {
      await linkDomain({domain: 'example.com', project: 'prj_123', provider: 'cloudflare', subdomain: 'app', timeoutSeconds: 0})
    } catch (error_) {
      error = error_
    }

    expect(error).to.be.instanceOf(DoomainError)
    expect(dnsBodies).to.deep.include({content: 'vc-domain-verify=app.example.com,late-token', name: '_vercel.example.com', ttl: 3600, type: 'TXT'})
  })

  it('does not treat a Vercel domain conflict as already added unless it is on the target project', async () => {
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'

      if (url.hostname === 'api.vercel.com') {
        if (method === 'POST' && url.pathname === '/v10/projects/prj_123/domains') {
          return jsonErrorResponse(409, {error: {code: 'ALIAS_DOMAIN_EXIST', message: 'Domain is already assigned.'}})
        }

        if (method === 'GET' && url.pathname === '/v9/projects/prj_123/domains/app.example.com') {
          return jsonErrorResponse(404, {error: {code: 'not_found', message: 'Project Domain not found.'}})
        }
      }

      throw new Error(`Unexpected request: ${method} ${url.href}`)
    }) as typeof fetch

    let error: unknown
    try {
      await createVercelClient({token: 'vercel_token'}).addDomainToProject('prj_123', 'app.example.com')
    } catch (error_) {
      error = error_
    }

    expect(error).to.be.instanceOf(DoomainError)
    expect((error as DoomainError).code).to.equal('DOMAIN_ALREADY_ASSIGNED')
    expect((error as DoomainError).message).to.include('already assigned to another project')
  })

  it('treats a Vercel domain conflict as already added when it is on the target project', async () => {
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'

      if (url.hostname === 'api.vercel.com') {
        if (method === 'POST' && url.pathname === '/v10/projects/prj_123/domains') {
          return jsonErrorResponse(409, {error: {code: 'ALIAS_DOMAIN_EXIST', message: 'Domain is already assigned.'}})
        }

        if (method === 'GET' && url.pathname === '/v9/projects/prj_123/domains/app.example.com') {
          return jsonResponse({name: 'app.example.com', verified: true})
        }
      }

      throw new Error(`Unexpected request: ${method} ${url.href}`)
    }) as typeof fetch

    const result = await createVercelClient({token: 'vercel_token'}).addDomainToProject('prj_123', 'app.example.com')

    expect(result.alreadyAdded).to.equal(true)
    expect(result.raw).to.deep.equal({name: 'app.example.com', verified: true})
  })

  it('moves a Vercel domain from another project when force is enabled', async () => {
    let addAttempts = 0
    const requests: string[] = []

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      requests.push(`${method} ${url.pathname}`)

      if (url.hostname === 'api.vercel.com') {
        if (method === 'POST' && url.pathname === '/v10/projects/prj_new/domains') {
          addAttempts += 1
          return addAttempts === 1
            ? jsonErrorResponse(409, {error: {code: 'ALIAS_DOMAIN_EXIST', message: 'Domain is already assigned.'}})
            : jsonResponse({name: 'app.example.com', verified: true})
        }

        if (method === 'GET' && url.pathname === '/v9/projects/prj_new/domains/app.example.com') {
          return jsonErrorResponse(404, {error: {code: 'not_found', message: 'Project Domain not found.'}})
        }

        if (method === 'GET' && url.pathname === '/v9/projects') {
          return jsonResponse({projects: [{id: 'prj_old', name: 'old-project'}]})
        }

        if (method === 'GET' && url.pathname === '/v9/projects/prj_old/domains') {
          return jsonResponse({domains: [{name: 'app.example.com', projectId: 'prj_old'}]})
        }

        if (method === 'DELETE' && url.pathname === '/v9/projects/prj_old/domains/app.example.com') {
          return jsonResponse({})
        }
      }

      throw new Error(`Unexpected request: ${method} ${url.href}`)
    }) as typeof fetch

    const result = await createVercelClient({token: 'vercel_token'}).addDomainToProject('prj_new', 'app.example.com', {
      force: true,
    })

    expect(result.alreadyAdded).to.equal(false)
    expect(result.raw).to.deep.equal({name: 'app.example.com', verified: true})
    expect(requests).to.include('DELETE /v9/projects/prj_old/domains/app.example.com')
  })
})
