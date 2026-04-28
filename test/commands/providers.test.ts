import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {runCommand} from '@oclif/test'
import {expect} from 'chai'

import {loadConfig, saveConfig} from '../../src/lib/config.js'

describe('providers', () => {
  const env = {...process.env}
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'doomain-providers-'))
    process.env = {...env, DOOMAIN_CONFIG_FILE: join(dir, 'config.json')}
    delete process.env.SPACESHIP_API_KEY
    delete process.env.SPACESHIP_API_SECRET
    delete process.env.NAMECHEAP_API_USER
    delete process.env.NAMECHEAP_API_KEY
    delete process.env.NAMECHEAP_CLIENT_IP
    delete process.env.CLOUDFLARE_API_TOKEN
    delete process.env.CLOUDFLARE_ACCOUNT_ID
  })

  afterEach(() => {
    process.env = {...env}
    rmSync(dir, {force: true, recursive: true})
  })

  it('reports provider configuration status without verification', async () => {
    const {stdout} = await runCommand('providers status --no-verify --json')
    const result = JSON.parse(stdout) as {
      ok: boolean
      data: {providers: Array<{configured: boolean; id: string}>}
    }

    expect(result.ok).to.equal(true)
    expect(result.data.providers.map((provider) => ({configured: provider.configured, id: provider.id}))).to.deep.equal([
      {configured: false, id: 'spaceship'},
      {configured: false, id: 'namecheap'},
      {configured: false, id: 'cloudflare'},
    ])
  })

  it('disconnects a saved provider without removing unrelated config', async () => {
    await saveConfig({
      defaults: {domain: 'example.com', provider: 'namecheap'},
      providers: {
        cloudflare: {credentials: {accountId: 'account_123', apiToken: 'cloudflare_token'}},
        namecheap: {credentials: {apiKey: 'namecheap_key', apiUser: 'user', clientIp: '127.0.0.1'}},
      },
      vercel: {teamId: 'team_123', token: 'vercel_token'},
    })

    const {stdout} = await runCommand('providers disconnect namecheap --json')
    const result = JSON.parse(stdout) as {data: {provider: string; removed: boolean}; ok: boolean}
    const config = await loadConfig()

    expect(result.ok).to.equal(true)
    expect(result.data.provider).to.equal('namecheap')
    expect(result.data.removed).to.equal(true)
    expect(config.providers?.namecheap).to.equal(undefined)
    expect(config.providers?.cloudflare).to.deep.equal({credentials: {accountId: 'account_123', apiToken: 'cloudflare_token'}})
    expect(config.vercel).to.deep.equal({teamId: 'team_123', token: 'vercel_token'})
    expect(config.defaults).to.deep.equal({domain: 'example.com'})
  })
})
