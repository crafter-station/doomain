import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCommand } from '@oclif/test'
import { expect } from 'chai'

function jsonResponse(body: unknown): Response {
  return { json: async () => body, ok: true, status: 200 } as Response
}

describe('dns point', () => {
  const originalFetch = globalThis.fetch
  const env = { ...process.env }
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'doomain-dns-point-'))
    process.env = {
      ...env,
      DOOMAIN_CONFIG_FILE: join(dir, 'config.json'),
      SPACESHIP_API_KEY: 'key',
      SPACESHIP_API_SECRET: 'secret',
    }
    for (const key of [
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
      'HOSTINGER_API_TOKEN',
      'NAMECHEAP_API_KEY',
      'NAMECHEAP_API_USER',
      'NAMECHEAP_CLIENT_IP',
      'NAMECHEAP_USERNAME',
    ]) {
      delete process.env[key]
    }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env = { ...env }
    rmSync(dir, { force: true, recursive: true })
  })

  it('prints exactly one JSON envelope for a dry run', async () => {
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/v1/domains') return jsonResponse({ items: [{ name: 'example.com' }], total: 1 })
      if (url.pathname === '/api/v1/dns/records/example.com') return jsonResponse({ items: [], total: 0 })
      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const { stdout } = await runCommand('dns point app.example.com --target 203.0.113.10 --dry-run --json')

    expect(stdout).to.equal(
      `${JSON.stringify({
        ok: true,
        data: {
          account: 'default',
          accountInferred: true,
          domain: 'app.example.com',
          dryRun: true,
          isDefaultAccount: true,
          provider: 'spaceship',
          providerInferred: true,
          propagated: false,
          record: { name: 'app', ttl: 300, type: 'A', value: '203.0.113.10' },
          skipped: [],
          updated: false,
          zoneDomain: 'example.com',
        },
      })}\n`,
    )
  })

  it('returns one conflict error without writing in non-interactive mode', async () => {
    const requests: string[] = []
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      if (url.pathname === '/api/v1/domains') return jsonResponse({ items: [{ name: 'example.com' }], total: 1 })
      if (url.pathname === '/api/v1/dns/records/example.com') {
        return jsonResponse({ items: [{ address: '192.0.2.1', name: 'app', ttl: 300, type: 'A' }], total: 1 })
      }

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const { stdout } = await runCommand('dns point app.example.com --target 203.0.113.10 --provider spaceship --json')
    const result = JSON.parse(stdout) as {
      error: {
        code: string
        details: { conflicts: Array<{ existing: { value: string } }>; recovery: string; suggestedCommands: string[] }
      }
      ok: boolean
    }

    expect(stdout.trim().split('\n')).to.have.length(1)
    expect(result.ok).to.equal(false)
    expect(result.error.code).to.equal('DNS_TARGET_CONFLICT')
    expect(result.error.details.conflicts[0].existing.value).to.equal('192.0.2.1')
    expect(result.error.details.recovery).to.include('Re-run with --force')
    expect(result.error.details.suggestedCommands).to.deep.equal([
      'doomain dns point app.example.com --target 203.0.113.10 --provider spaceship --force --json',
    ])
    expect(requests.some((request) => request.startsWith('PUT '))).to.equal(false)
  })

  it('writes the record and reports propagation as unchecked with --no-wait', async () => {
    const requests: string[] = []
    const bodies: unknown[] = []
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      requests.push(`${method} ${url.pathname}`)
      if (url.pathname === '/api/v1/domains') return jsonResponse({ items: [{ name: 'example.com' }], total: 1 })
      if (method === 'GET' && url.pathname === '/api/v1/dns/records/example.com')
        return jsonResponse({ items: [], total: 0 })
      if (method === 'PUT' && url.pathname === '/api/v1/dns/records/example.com') {
        bodies.push(JSON.parse(String(init?.body)))
        return jsonResponse({})
      }

      throw new Error(`Unexpected request: ${method} ${url.href}`)
    }) as typeof fetch

    const { stdout } = await runCommand(
      'dns point app.example.com --target 203.0.113.10 --provider spaceship --no-wait --json',
    )
    const result = JSON.parse(stdout) as { data: { propagated: boolean; updated: boolean }; ok: boolean }

    expect(stdout.trim().split('\n')).to.have.length(1)
    expect(result).to.deep.include({ ok: true })
    expect(result.data).to.deep.include({ propagated: false, updated: true })
    expect(requests).to.include('PUT /api/v1/dns/records/example.com')
    expect(bodies).to.deep.equal([
      { force: true, items: [{ address: '203.0.113.10', name: 'app', ttl: 300, type: 'A' }] },
    ])
  })

  it('uses a DNS-specific fallback code for unexpected failures', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network unavailable')
    }) as typeof fetch

    const { stdout } = await runCommand('dns point app.example.com --target 203.0.113.10 --provider spaceship --json')
    const result = JSON.parse(stdout) as { error: { code: string; message: string }; ok: boolean }

    expect(result).to.deep.equal({
      error: { code: 'DNS_POINT_FAILED', message: 'network unavailable' },
      ok: false,
    })
  })

  it('returns dns point recovery commands when no provider is configured', async () => {
    delete process.env.SPACESHIP_API_KEY
    delete process.env.SPACESHIP_API_SECRET

    const { stdout } = await runCommand('dns point app.example.com --target 203.0.113.10 --json')
    const result = JSON.parse(stdout) as {
      error: { code: string; details: { recovery: string; suggestedCommands: string[] } }
      ok: boolean
    }

    expect(result.ok).to.equal(false)
    expect(result.error.code).to.equal('CONFIG_NOT_FOUND')
    expect(result.error.details.recovery).to.include('doomain dns point app.example.com --target 203.0.113.10 --json')
    expect(result.error.details.suggestedCommands).to.deep.equal([
      'doomain providers connect',
      'doomain dns point app.example.com --target 203.0.113.10 --json',
    ])
  })
})
