import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCommand } from '@oclif/test'
import { expect } from 'chai'

describe('schema', () => {
  const env = { ...process.env }
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'doomain-schema-'))
    process.env = { ...env, DOOMAIN_CONFIG_FILE: join(dir, 'config.json') }
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account_123'
    process.env.CLOUDFLARE_API_TOKEN = 'cloudflare_token'
  })

  afterEach(() => {
    process.env = { ...env }
    rmSync(dir, { force: true, recursive: true })
  })

  it('tells agents to try link first and includes provider connection status', async () => {
    const { stdout } = await runCommand('schema link --json')
    const result = JSON.parse(stdout) as {
      data: {
        agentHint: string
        agentInstructions: string[]
        agentQuickstart: { doNotPreflight: boolean; preferredFirstCommand: string }
        configuredProviders: Array<{ account: string; configured: boolean; id: string; isDefaultAccount: boolean }>
        examples: string[]
        flags: Array<{ description: string; name: string }>
      }
      ok: boolean
    }

    expect(result.ok).to.equal(true)
    expect(result.data.agentHint).to.include('try `doomain link <domain> --json` first')
    expect(result.data.agentInstructions).to.include(
      'Do not run `providers status`, `projects list`, `--help`, or `--dry-run` before the first link attempt unless the user asks for a preview or diagnosis.',
    )
    expect(result.data.agentQuickstart).to.deep.equal({
      doNotPreflight: true,
      preferredFirstCommand: 'doomain link <domain> --json',
    })
    expect(result.data.configuredProviders).to.deep.include({
      account: 'default',
      accountLabel: 'cloudflare/default',
      configured: true,
      default: false,
      displayName: 'Cloudflare',
      docsUrl: 'https://developers.cloudflare.com/api/',
      id: 'cloudflare',
      isDefaultAccount: true,
      isPreferredProvider: false,
    })
    expect(result.data.examples).to.include('doomain link --project my-app --json')
    expect(result.data.examples).to.include(
      'doomain link app.example.com --provider spaceship --account work --project my-app --json',
    )
    expect(result.data.flags.find((flag) => flag.name === 'account')?.description).to.include('profile/account alias')
    expect(result.data.flags.find((flag) => flag.name === 'domain')?.description).to.include('DOOMAIN_DOMAIN')
    expect(result.data.flags.find((flag) => flag.name === 'dry-run')?.description).to.include(
      'agents should not use this',
    )
    expect(result.data.flags.find((flag) => flag.name === 'force')?.description).to.include(
      'Move existing Vercel project domains',
    )
    expect(result.data.flags.find((flag) => flag.name === 'force')?.description).to.include('conflicting DNS records')
    expect(result.data.flags.find((flag) => flag.name === 'wait')?.description).to.include('--no-wait')
  })

  it('documents JSON-capable public commands for agents', async () => {
    const { stdout } = await runCommand('schema --json')
    const result = JSON.parse(stdout) as { data: Array<{ name: string }>; ok: boolean }

    expect(result.ok).to.equal(true)
    expect(result.data.map((schema) => schema.name)).to.include.members([
      'schema',
      'providers list',
      'domains find',
      'domains list',
      'projects list',
      'verify',
      'clerk domains add',
      'dns point',
      'dns remove',
      'dns delete',
      'dns diagnose',
      'auth clerk',
    ])
  })

  it('documents agent-safe DNS pointing and provider connection status', async () => {
    const { stdout } = await runCommand('schema "dns point" --json')
    const result = JSON.parse(stdout) as {
      data: {
        agentHint: string
        configuredProviders: Array<{ configured: boolean; id: string }>
        flags: Array<{ description: string; name: string }>
        safeForAgents: boolean
      }
      ok: boolean
    }

    expect(result.ok).to.equal(true)
    expect(result.data.safeForAgents).to.equal(true)
    expect(result.data.agentHint).to.include('VPS or load balancer')
    expect(result.data.configuredProviders).to.deep.include({
      account: 'default',
      accountLabel: 'cloudflare/default',
      configured: true,
      default: false,
      displayName: 'Cloudflare',
      docsUrl: 'https://developers.cloudflare.com/api/',
      id: 'cloudflare',
      isDefaultAccount: true,
      isPreferredProvider: false,
    })
    expect(result.data.flags.map((flag) => flag.name)).to.include.members([
      'domain',
      'target',
      'type',
      'provider',
      'account',
      'ttl',
      'dry-run',
      'force',
      'wait',
      'timeout',
      'json',
    ])
    expect(result.data.flags.find((flag) => flag.name === 'wait')?.description).to.include('--no-wait')
  })

  it('documents domain provider discovery for agents', async () => {
    const { stdout } = await runCommand('schema "domains find" --json')
    const result = JSON.parse(stdout) as {
      data: { agentHint: string; examples: string[]; flags: Array<{ name: string }>; safeForAgents: boolean }
      ok: boolean
    }

    expect(result.ok).to.equal(true)
    expect(result.data.safeForAgents).to.equal(true)
    expect(result.data.agentHint).to.include('checks all configured provider accounts')
    expect(result.data.examples).to.include('doomain domains find hacktheandes.com --json')
    expect(result.data.flags.map((flag) => flag.name)).to.include.members(['domain', 'provider', 'account', 'json'])
  })

  it('documents first-time Clerk production setup and its guardrail', async () => {
    const { stdout } = await runCommand('schema "clerk domains add" --json')
    const result = JSON.parse(stdout) as {
      data: { agentHint: string; configuredProviders: unknown[]; flags: Array<{ name: string }> }
      ok: boolean
    }

    expect(result.ok).to.equal(true)
    expect(result.data.agentHint).to.include('first-time Clerk production setup')
    expect(result.data.agentHint).to.include('CLERK_PRODUCTION_EXISTS')
    expect(result.data.flags.map((flag) => flag.name)).to.include.members([
      'app',
      'provider',
      'account',
      'dry-run',
      'force',
      'wait',
    ])
    expect(result.data.configuredProviders).to.be.an('array')
  })
})
