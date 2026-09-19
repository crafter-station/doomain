import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'

import { getVercelCliAuthFiles, listGlobalVercelTokens } from '../../src/lib/vercel-auth.js'
import { runEffect } from '../helpers/effect.js'

describe('listGlobalVercelTokens', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'doomain-vercel-auth-'))
  })

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true })
  })

  it('reads the Vercel CLI auth token', async () => {
    const authFile = join(dir, '.vercel', 'auth.json')
    mkdirSync(join(dir, '.vercel'), { recursive: true })
    writeFileSync(authFile, JSON.stringify({ token: 'cli_token' }))

    const tokens = await runEffect(listGlobalVercelTokens({ authFile, env: {} }))

    expect(tokens).to.deep.equal([{ authFile, label: 'Vercel CLI', source: 'vercel-cli', token: 'cli_token' }])
  })

  it('lists VERCEL_TOKEN before a unique Vercel CLI token', async () => {
    const authFile = join(dir, '.vercel', 'auth.json')
    mkdirSync(join(dir, '.vercel'), { recursive: true })
    writeFileSync(authFile, JSON.stringify({ token: 'cli_token' }))

    const tokens = await runEffect(listGlobalVercelTokens({ authFile, env: { VERCEL_TOKEN: 'env_token' } }))

    expect(tokens).to.deep.equal([
      { label: 'VERCEL_TOKEN', source: 'environment', token: 'env_token' },
      { authFile, label: 'Vercel CLI', source: 'vercel-cli', token: 'cli_token' },
    ])
  })

  it('checks the current Vercel CLI data directory before legacy paths', () => {
    const dataDir = join(dir, 'data')

    const authFiles = getVercelCliAuthFiles({ XDG_DATA_HOME: dataDir })

    expect(authFiles[0]).to.equal(join(dataDir, 'com.vercel.cli', 'auth.json'))
    expect(authFiles).to.include(join(dataDir, 'now', 'auth.json'))
  })
})
