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
})
