import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'

import { findDomainProvider } from '../../src/index.js'
import { saveConfig } from '../../src/lib/config.js'
import { resolveProviderTarget } from '../../src/lib/domain-provider.js'

function jsonResponse(body: unknown, status = 200): Response {
  return { json: async () => body, ok: status >= 200 && status < 300, status } as Response
}

describe('findDomainProvider', () => {
  const originalFetch = globalThis.fetch
  const env = { ...process.env }
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'doomain-domain-provider-'))
    process.env = { ...env, DOOMAIN_CONFIG_FILE: join(dir, 'config.json') }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env = { ...env }
    rmSync(dir, { force: true, recursive: true })
  })

  it('finds a matching configured provider account when another provider fails', async () => {
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
        return jsonResponse({ message: 'Unauthenticated.' }, 401)
      }

      if (url.hostname === 'spaceship.dev' && url.pathname === '/api/v1/domains') {
        return jsonResponse({ items: [{ name: 'hacktheandes.com' }], total: 1 })
      }

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const result = await findDomainProvider({ domain: 'api.hacktheandes.com' })

    expect(result).to.deep.equal({
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
    })
  })

  it('continues across accounts when discovery is limited to one provider', async () => {
    await saveConfig({
      providers: {
        spaceship: {
          accounts: { work: { credentials: { apiKey: 'work_key', apiSecret: 'work_secret' } } },
          credentials: { apiKey: 'expired_key', apiSecret: 'expired_secret' },
        },
      },
    })

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const headers = init?.headers as Record<string, string>

      if (url.hostname === 'spaceship.dev' && url.pathname === '/api/v1/domains') {
        return headers['X-Api-Key'] === 'work_key'
          ? jsonResponse({ items: [{ name: 'example.com' }], total: 1 })
          : jsonResponse({ message: 'Unauthenticated.' }, 401)
      }

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const result = await findDomainProvider({ domain: 'api.example.com', provider: 'spaceship' })

    expect(result.provider).to.equal('spaceship')
    expect(result.account).to.equal('work')
    expect(result.complete).to.equal(false)
    expect(result.warnings).to.deep.equal([
      {
        account: 'default',
        error: {
          code: 'PROVIDER_AUTH_FAILED',
          message:
            'Spaceship rejected the API key/secret. Re-run `doomain providers connect spaceship` with valid credentials.',
        },
        isDefaultAccount: true,
        provider: 'spaceship',
        providerName: 'Spaceship',
      },
    ])
  })

  it('uses the unique healthy account for a mutating command when the default account is broken', async () => {
    await saveConfig({
      providers: {
        spaceship: {
          accounts: { personal: { credentials: { apiKey: 'personal_key', apiSecret: 'personal_secret' } } },
          credentials: { apiKey: 'expired_key', apiSecret: 'expired_secret' },
        },
      },
    })

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const headers = init?.headers as Record<string, string>
      if (url.pathname === '/api/v1/domains') {
        return headers['X-Api-Key'] === 'personal_key'
          ? jsonResponse({ items: [{ name: 'example.com' }], total: 1 })
          : jsonResponse({ message: 'Unauthenticated.' }, 401)
      }
      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const result = await resolveProviderTarget({ domain: 'app.example.com', provider: 'spaceship' })

    expect(result.account).to.equal('personal')
    expect(result.warnings).to.have.length(1)
    expect(result.warnings[0]).to.include({ account: 'default', provider: 'spaceship' })
  })
})
