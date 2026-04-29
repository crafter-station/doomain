import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {runCommand} from '@oclif/test'
import {expect} from 'chai'

describe('schema', () => {
  const env = {...process.env}
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'doomain-schema-'))
    process.env = {...env, DOOMAIN_CONFIG_FILE: join(dir, 'config.json')}
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account_123'
    process.env.CLOUDFLARE_API_TOKEN = 'cloudflare_token'
  })

  afterEach(() => {
    process.env = {...env}
    rmSync(dir, {force: true, recursive: true})
  })

  it('tells agents to try link first and includes provider connection status', async () => {
    const {stdout} = await runCommand('schema link --json')
    const result = JSON.parse(stdout) as {
      data: {
        agentHint: string
        agentInstructions: string[]
        agentQuickstart: {doNotPreflight: boolean; preferredFirstCommand: string}
        configuredProviders: Array<{configured: boolean; id: string}>
        flags: Array<{description: string; name: string}>
      }
      ok: boolean
    }

    expect(result.ok).to.equal(true)
    expect(result.data.agentHint).to.include('try `doomain link <domain> --json` first')
    expect(result.data.agentInstructions).to.include('Do not run `providers status`, `projects list`, `--help`, or `--dry-run` before the first link attempt unless the user asks for a preview or diagnosis.')
    expect(result.data.agentQuickstart).to.deep.equal({
      doNotPreflight: true,
      preferredFirstCommand: 'doomain link <domain> --json',
    })
    expect(result.data.configuredProviders).to.deep.include({
      configured: true,
      default: false,
      displayName: 'Cloudflare',
      docsUrl: 'https://developers.cloudflare.com/api/',
      id: 'cloudflare',
    })
    expect(result.data.flags.find((flag) => flag.name === 'dry-run')?.description).to.include('agents should not use this')
  })
})
