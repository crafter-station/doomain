import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCommand } from '@oclif/test'
import { expect } from 'chai'

import { saveConfig as saveConfigEffect } from '../../src/lib/config.js'
import { runEffect } from '../helpers/effect.js'

const saveConfig = (...args: Parameters<typeof saveConfigEffect>) => runEffect(saveConfigEffect(...args))

function cloudflareResponse(result: unknown) {
  return { errors: [], messages: [], result, result_info: { page: 1, total_pages: 1 }, success: true }
}

function jsonResponse(body: unknown): Response {
  return { json: async () => body, ok: true, status: 200 } as Response
}

function errorResponse(body: unknown, status: number): Response {
  return { json: async () => body, ok: false, status } as Response
}

describe('domains', () => {
  const originalFetch = globalThis.fetch
  const env = { ...process.env }
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'doomain-domains-'))
    process.env = {
      ...env,
      CLOUDFLARE_ACCOUNT_ID: 'account_123',
      CLOUDFLARE_API_TOKEN: 'token',
      DOOMAIN_CONFIG_FILE: join(dir, 'config.json'),
    }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env = { ...env }
    rmSync(dir, { force: true, recursive: true })
  })

  it('resolves provider zone id before listing records for a domain filter', async () => {
    const requests: string[] = []
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))
      requests.push(url.pathname)

      if (url.pathname === '/client/v4/zones')
        return jsonResponse(cloudflareResponse([{ id: 'zone_1', name: 'example.com' }]))
      if (url.pathname === '/client/v4/zones/zone_1/dns_records') return jsonResponse(cloudflareResponse([]))

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const { stdout } = await runCommand('domains list --provider cloudflare --domain example.com --json')
    const result = JSON.parse(stdout) as { data: { zones: Array<{ zone: { id: string; name: string } }> }; ok: boolean }

    expect(result.ok).to.equal(true)
    expect(result.data.zones[0].zone).to.deep.equal({
      id: 'zone_1',
      metadata: { cloudflare: { id: 'zone_1', name: 'example.com' } },
      name: 'example.com',
    })
    expect(requests).to.deep.equal(['/client/v4/zones', '/client/v4/zones/zone_1/dns_records'])
  })

  it('lists zones and records for a named provider account', async () => {
    await saveConfig({
      providers: {
        spaceship: { accounts: { work: { credentials: { apiKey: 'work_key', apiSecret: 'work_secret' } } } },
      },
    })

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const headers = init?.headers as Record<string, string>
      expect(headers['X-Api-Key']).to.equal('work_key')

      if (url.hostname === 'spaceship.dev' && url.pathname === '/api/v1/domains') {
        return jsonResponse({ items: [{ name: 'example.com' }], total: 1 })
      }

      if (url.hostname === 'spaceship.dev' && url.pathname === '/api/v1/dns/records/example.com') {
        return jsonResponse({ items: [], total: 0 })
      }

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const { stdout } = await runCommand('domains list --provider spaceship --account work --json')
    const result = JSON.parse(stdout) as {
      data: {
        account: string
        provider: string
        zones: Array<{ account: string; isDefaultAccount: boolean; zone: { name: string } }>
      }
      ok: boolean
    }

    expect(result.ok).to.equal(true)
    expect(result.data.provider).to.equal('spaceship')
    expect(result.data.account).to.equal('work')
    expect(result.data.zones[0]).to.deep.include({ account: 'work', isDefaultAccount: false })
    expect(result.data.zones[0].zone.name).to.equal('example.com')
  })

  it('finds the provider and account for a domain despite another provider failure', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = ''
    process.env.CLOUDFLARE_API_TOKEN = ''
    await saveConfig({
      providers: {
        hostinger: { credentials: { apiToken: 'expired_token' } },
        spaceship: {
          accounts: { personal: { credentials: { apiKey: 'personal_key', apiSecret: 'personal_secret' } } },
        },
      },
    })

    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))

      if (url.hostname === 'developers.hostinger.com') {
        return errorResponse({ message: 'Unauthenticated.' }, 401)
      }

      if (url.hostname === 'spaceship.dev' && url.pathname === '/api/v1/domains') {
        return jsonResponse({ items: [{ name: 'hacktheandes.com' }], total: 1 })
      }

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const { stdout } = await runCommand('domains find api.hacktheandes.com --json')
    const result = JSON.parse(stdout) as {
      data: { account: string; domain: string; provider: string; recordName: string; zoneDomain: string }
      ok: boolean
    }

    expect(result).to.deep.equal({
      data: {
        account: 'personal',
        accountInferred: true,
        complete: false,
        domain: 'api.hacktheandes.com',
        isApex: false,
        isDefaultAccount: false,
        provider: 'spaceship',
        providerInferred: true,
        recordName: 'api',
        warnings: [
          {
            account: 'default',
            error: {
              code: 'PROVIDER_AUTH_FAILED',
              message:
                'Hostinger rejected the API token. Re-run `doomain providers connect hostinger` with a valid token.',
            },
            isDefaultAccount: true,
            provider: 'hostinger',
            providerName: 'Hostinger',
          },
        ],
        zoneDomain: 'hacktheandes.com',
      },
      ok: true,
    })
  })

  it('returns discovery-specific recovery commands when no provider is configured', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = ''
    process.env.CLOUDFLARE_API_TOKEN = ''
    process.env.HOSTINGER_API_TOKEN = ''
    process.env.NAMECHEAP_API_KEY = ''
    process.env.NAMECHEAP_API_USER = ''
    process.env.NAMECHEAP_CLIENT_IP = ''
    process.env.SPACESHIP_API_KEY = ''
    process.env.SPACESHIP_API_SECRET = ''

    const { stdout } = await runCommand('domains find example.com --json')
    const result = JSON.parse(stdout) as {
      error: { code: string; details: { recovery: string; suggestedCommands: string[] } }
      ok: boolean
    }

    expect(result.ok).to.equal(false)
    expect(result.error.code).to.equal('CONFIG_NOT_FOUND')
    expect(result.error.details.recovery).to.include('doomain domains find example.com --json')
    expect(result.error.details.suggestedCommands).to.deep.equal([
      'doomain providers connect',
      'doomain domains find example.com --json',
    ])
  })
})
