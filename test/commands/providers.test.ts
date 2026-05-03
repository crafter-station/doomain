import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {runCommand} from '@oclif/test'
import {expect} from 'chai'

import {loadConfig, saveConfig} from '../../src/lib/config.js'
import {providerAccountHasCredentials, withProviderAccountCredentials} from '../../src/lib/providers/core/config.js'

describe('providers', () => {
  const originalFetch = globalThis.fetch
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
    delete process.env.HOSTINGER_API_TOKEN
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env = {...env}
    rmSync(dir, {force: true, recursive: true})
  })

  function jsonResponse(body: unknown): Response {
    return {json: async () => body, ok: true, status: 200} as Response
  }

  it('detects saved provider account credentials', () => {
    expect(
      providerAccountHasCredentials(
        {providers: {spaceship: {accounts: {work: {credentials: {apiKey: 'work_key'}}}, credentials: {apiKey: 'default_key'}}}},
        'spaceship',
      ),
    ).to.equal(true)
    expect(providerAccountHasCredentials({providers: {spaceship: {apiKey: 'legacy_key', apiSecret: 'legacy_secret'}}}, 'spaceship')).to.equal(
      true,
    )
    expect(
      providerAccountHasCredentials(
        {providers: {spaceship: {accounts: {work: {credentials: {apiKey: 'work_key', apiSecret: 'work_secret'}}}}}},
        'spaceship',
        'work',
      ),
    ).to.equal(true)
  })

  it('writes default provider account credentials without removing named accounts', () => {
    const config = withProviderAccountCredentials(
      {accounts: {work: {credentials: {apiKey: 'work_key', apiSecret: 'work_secret'}}}, settings: {region: 'us'}},
      'default',
      {apiKey: 'default_key', apiSecret: 'default_secret'},
    )

    expect(config).to.deep.equal({
      accounts: {work: {credentials: {apiKey: 'work_key', apiSecret: 'work_secret'}}},
      credentials: {apiKey: 'default_key', apiSecret: 'default_secret'},
      settings: {region: 'us'},
    })
  })

  it('writes named provider account credentials without removing other accounts', () => {
    const config = withProviderAccountCredentials(
      {
        accounts: {personal: {credentials: {apiKey: 'personal_key', apiSecret: 'personal_secret'}}},
        credentials: {apiKey: 'default_key', apiSecret: 'default_secret'},
      },
      'work',
      {apiKey: 'work_key', apiSecret: 'work_secret'},
    )

    expect(config).to.deep.equal({
      accounts: {
        personal: {credentials: {apiKey: 'personal_key', apiSecret: 'personal_secret'}},
        work: {credentials: {apiKey: 'work_key', apiSecret: 'work_secret'}},
      },
      credentials: {apiKey: 'default_key', apiSecret: 'default_secret'},
    })
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
      {configured: false, id: 'hostinger'},
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

  it('connects a named provider account without overwriting the default account', async () => {
    await saveConfig({providers: {spaceship: {credentials: {apiKey: 'default_key', apiSecret: 'default_secret'}}}})

    const {stdout} = await runCommand(
      'providers connect spaceship --account work --credential apiKey=work_key --credential apiSecret=work_secret --no-verify --json',
    )
    const result = JSON.parse(stdout) as {data: {account: string; isDefaultAccount: boolean; provider: string}; ok: boolean}
    const config = await loadConfig()

    expect(result.ok).to.equal(true)
    expect(result.data.provider).to.equal('spaceship')
    expect(result.data.account).to.equal('work')
    expect(result.data.isDefaultAccount).to.equal(false)
    expect(config.providers?.spaceship?.credentials).to.deep.equal({apiKey: 'default_key', apiSecret: 'default_secret'})
    expect(config.providers?.spaceship?.accounts?.work?.credentials).to.deep.equal({apiKey: 'work_key', apiSecret: 'work_secret'})
  })

  it('connects the default provider account in JSON mode when --account is omitted', async () => {
    const {stdout} = await runCommand(
      'providers connect spaceship --credential apiKey=default_key --credential apiSecret=default_secret --no-verify --json',
    )
    const result = JSON.parse(stdout) as {data: {account: string; isDefaultAccount: boolean}; ok: boolean}
    const config = await loadConfig()

    expect(result.ok).to.equal(true)
    expect(result.data.account).to.equal('default')
    expect(result.data.isDefaultAccount).to.equal(true)
    expect(config.providers?.spaceship?.credentials).to.deep.equal({apiKey: 'default_key', apiSecret: 'default_secret'})
  })

  it('reports default and named provider accounts in status output', async () => {
    await saveConfig({
      providers: {
        spaceship: {
          accounts: {work: {credentials: {apiKey: 'work_key', apiSecret: 'work_secret'}}},
          credentials: {apiKey: 'default_key', apiSecret: 'default_secret'},
        },
      },
    })

    const {stdout} = await runCommand('providers status --no-verify --json')
    const result = JSON.parse(stdout) as {
      data: {providers: Array<{account: string; configured: boolean; id: string; isDefaultAccount: boolean}>}
      ok: boolean
    }

    expect(result.ok).to.equal(true)
    const statuses = result.data.providers.map((provider) => ({
      account: provider.account,
      configured: provider.configured,
      id: provider.id,
      isDefaultAccount: provider.isDefaultAccount,
    }))
    expect(statuses).to.deep.include({account: 'default', configured: true, id: 'spaceship', isDefaultAccount: true})
    expect(statuses).to.deep.include({account: 'work', configured: true, id: 'spaceship', isDefaultAccount: false})
  })

  it('verifies a named provider account with that account credentials', async () => {
    await saveConfig({providers: {spaceship: {accounts: {work: {credentials: {apiKey: 'work_key', apiSecret: 'work_secret'}}}}}})

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const headers = init?.headers as Record<string, string>
      expect(url.hostname).to.equal('spaceship.dev')
      expect(url.pathname).to.equal('/api/v1/domains')
      expect(headers['X-Api-Key']).to.equal('work_key')
      expect(headers['X-Api-Secret']).to.equal('work_secret')
      return jsonResponse({items: [], total: 0})
    }) as typeof fetch

    const {stdout} = await runCommand('providers verify spaceship --account work --json')
    const result = JSON.parse(stdout) as {data: {account: string; provider: string}; ok: boolean}

    expect(result.ok).to.equal(true)
    expect(result.data.provider).to.equal('spaceship')
    expect(result.data.account).to.equal('work')
  })

  it('uses provider environment credentials when verifying a named account', async () => {
    process.env.SPACESHIP_API_KEY = 'env_key'
    process.env.SPACESHIP_API_SECRET = 'env_secret'
    await saveConfig({providers: {spaceship: {accounts: {work: {credentials: {apiKey: 'work_key', apiSecret: 'work_secret'}}}}}})

    globalThis.fetch = (async (_input, init) => {
      const headers = init?.headers as Record<string, string>
      expect(headers['X-Api-Key']).to.equal('env_key')
      expect(headers['X-Api-Secret']).to.equal('env_secret')
      return jsonResponse({items: [], total: 0})
    }) as typeof fetch

    const {stdout} = await runCommand('providers verify spaceship --account work --json')
    const result = JSON.parse(stdout) as {ok: boolean}

    expect(result.ok).to.equal(true)
  })

  it('disconnects only a named provider account when --account is passed', async () => {
    await saveConfig({
      providers: {
        spaceship: {
          accounts: {work: {credentials: {apiKey: 'work_key', apiSecret: 'work_secret'}}},
          credentials: {apiKey: 'default_key', apiSecret: 'default_secret'},
        },
      },
    })

    const {stdout} = await runCommand('providers disconnect spaceship --account work --json')
    const result = JSON.parse(stdout) as {data: {account: string; removed: boolean}; ok: boolean}
    const config = await loadConfig()

    expect(result.ok).to.equal(true)
    expect(result.data.account).to.equal('work')
    expect(result.data.removed).to.equal(true)
    expect(config.providers?.spaceship?.credentials).to.deep.equal({apiKey: 'default_key', apiSecret: 'default_secret'})
    expect(config.providers?.spaceship?.accounts).to.equal(undefined)
  })

  it('disconnects only the default provider account when --account default is passed', async () => {
    await saveConfig({
      defaults: {provider: 'spaceship'},
      providers: {
        spaceship: {
          accounts: {work: {credentials: {apiKey: 'work_key', apiSecret: 'work_secret'}}},
          credentials: {apiKey: 'default_key', apiSecret: 'default_secret'},
        },
      },
    })

    const {stdout} = await runCommand('providers disconnect spaceship --account default --json')
    const result = JSON.parse(stdout) as {data: {account: string; removed: boolean}; ok: boolean}
    const config = await loadConfig()

    expect(result.ok).to.equal(true)
    expect(result.data.account).to.equal('default')
    expect(result.data.removed).to.equal(true)
    expect(config.providers?.spaceship?.credentials).to.equal(undefined)
    expect(config.providers?.spaceship?.accounts?.work?.credentials).to.deep.equal({apiKey: 'work_key', apiSecret: 'work_secret'})
    expect(config.defaults).to.deep.equal({provider: 'spaceship'})
  })

  it('disconnects all accounts for a provider when --account is omitted', async () => {
    await saveConfig({
      defaults: {domain: 'example.com', provider: 'spaceship'},
      providers: {
        spaceship: {
          accounts: {work: {credentials: {apiKey: 'work_key', apiSecret: 'work_secret'}}},
          credentials: {apiKey: 'default_key', apiSecret: 'default_secret'},
        },
      },
    })

    const {stdout} = await runCommand('providers disconnect spaceship --json')
    const result = JSON.parse(stdout) as {data: {removed: boolean}; ok: boolean}
    const config = await loadConfig()

    expect(result.ok).to.equal(true)
    expect(result.data.removed).to.equal(true)
    expect(config.providers).to.equal(undefined)
    expect(config.defaults).to.deep.equal({domain: 'example.com'})
  })
})
