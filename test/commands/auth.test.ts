import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {runCommand} from '@oclif/test'
import {expect} from 'chai'

import {loadConfig, saveConfig} from '../../src/lib/config.js'

describe('auth', () => {
  const env = {...process.env}
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'doomain-auth-'))
    process.env = {...env, DOOMAIN_CONFIG_FILE: join(dir, 'config.json')}
    delete process.env.VERCEL_TOKEN
    delete process.env.VERCEL_TEAM_ID
    delete process.env.CLERK_APPLICATION_ID
    delete process.env.CLERK_PLATFORM_API_KEY
  })

  afterEach(() => {
    process.env = {...env}
    rmSync(dir, {force: true, recursive: true})
  })

  it('logs out of saved Vercel credentials without removing providers', async () => {
    await saveConfig({
      defaults: {domain: 'example.com', provider: 'cloudflare'},
      providers: {cloudflare: {credentials: {accountId: 'account_123', apiToken: 'cloudflare_token'}}},
      vercel: {teamId: 'team_123', token: 'vercel_token'},
    })

    const {stdout} = await runCommand('auth logout vercel --json')
    const result = JSON.parse(stdout) as {data: {removed: boolean; service: string}; ok: boolean}
    const config = await loadConfig()

    expect(result.ok).to.equal(true)
    expect(result.data.service).to.equal('vercel')
    expect(result.data.removed).to.equal(true)
    expect(config.vercel).to.equal(undefined)
    expect(config.providers).to.deep.equal({cloudflare: {credentials: {accountId: 'account_123', apiToken: 'cloudflare_token'}}})
    expect(config.defaults).to.deep.equal({domain: 'example.com', provider: 'cloudflare'})
  })

  it('saves Vercel credentials from VERCEL_TOKEN in JSON mode', async () => {
    process.env.VERCEL_TOKEN = 'env_vercel_token'
    process.env.VERCEL_TEAM_ID = 'team_env'

    const {stdout} = await runCommand('auth vercel --json')
    const result = JSON.parse(stdout) as {data: {vercel: {teamId?: string; token?: string}}; ok: boolean}
    const config = await loadConfig()

    expect(result.ok).to.equal(true)
    expect(result.data.vercel).to.deep.equal({teamId: 'team_env', token: 'env_...oken'})
    expect(config.vercel).to.deep.equal({teamId: 'team_env', token: 'env_vercel_token'})
  })

  it('saves verified Clerk Platform API credentials in JSON mode', async () => {
    const originalFetch = globalThis.fetch
    process.env.CLERK_PLATFORM_API_KEY = 'ak_env_clerk_token'
    process.env.CLERK_APPLICATION_ID = 'app_123'
    globalThis.fetch = (async () => new Response(JSON.stringify({application_id: 'app_123', instances: []}), {status: 200})) as typeof fetch

    try {
      const {stdout} = await runCommand('auth clerk --json')
      const result = JSON.parse(stdout) as {data: {clerk: {appId: string; platformApiKey: string}}; ok: boolean}
      const config = await loadConfig()

      expect(result.ok).to.equal(true)
      expect(result.data.clerk).to.deep.equal({appId: 'app_123', platformApiKey: 'ak_e...oken'})
      expect(config.clerk).to.deep.equal({appId: 'app_123', platformApiKey: 'ak_env_clerk_token'})
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
