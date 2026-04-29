import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect} from 'chai'

import {DoomainError} from '../../src/lib/errors.js'
import {createVercelClient, resolveVercelConfig} from '../../src/lib/vercel.js'

function jsonResponse(body: unknown): Response {
  return {json: async () => body, ok: true, status: 200} as Response
}

function errorResponse(status: number, body: unknown): Response {
  return {json: async () => body, ok: false, status} as Response
}

describe('vercel client', () => {
  const originalFetch = globalThis.fetch
  const originalEnv = {...process.env}

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env = {...originalEnv}
  })

  it('lists teams from the token without scoping the request to a team', async () => {
    const requests: string[] = []

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      requests.push(`${url.pathname}?${url.searchParams.toString()}`)
      expect((init?.headers as Record<string, string>).Authorization).to.equal('Bearer vercel_token')

      if (url.hostname === 'api.vercel.com' && url.pathname === '/v2/teams') {
        return jsonResponse({
          pagination: {next: null},
          teams: [
            {id: 'team_b', membership: {role: 'MEMBER'}, name: 'Beta', slug: 'beta'},
            {id: 'team_a', membership: {role: 'OWNER'}, name: 'Alpha', slug: 'alpha'},
          ],
        })
      }

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const teams = await createVercelClient({teamId: 'team_existing', token: 'vercel_token'}).listTeams()

    expect(requests).to.deep.equal(['/v2/teams?limit=100'])
    expect(teams).to.deep.equal([
      {id: 'team_a', name: 'Alpha', role: 'OWNER', slug: 'alpha'},
      {id: 'team_b', name: 'Beta', role: 'MEMBER', slug: 'beta'},
    ])
  })

  it('resolves Vercel CLI auth when no local credentials are saved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doomain-vercel-config-'))

    try {
      process.env = {...originalEnv, DOOMAIN_CONFIG_FILE: join(dir, 'doomain.json'), XDG_DATA_HOME: join(dir, 'data')}
      delete process.env.VERCEL_TOKEN
      delete process.env.VERCEL_TEAM_ID

      const authDir = join(dir, 'data', 'com.vercel.cli')
      mkdirSync(authDir, {recursive: true})
      writeFileSync(join(authDir, 'auth.json'), JSON.stringify({token: 'cli_token'}))

      const config = await resolveVercelConfig()
      expect(config.token).to.equal('cli_token')
      expect(config.teamId).to.equal(undefined)
    } finally {
      rmSync(dir, {force: true, recursive: true})
    }
  })

  it('reports unauthorized Vercel tokens with an actionable error', async () => {
    globalThis.fetch = (async () => errorResponse(401, {error: {message: 'Not authorized'}})) as typeof fetch

    try {
      await createVercelClient({token: 'bad_token'}).listTeams()
      throw new Error('Expected listTeams to fail')
    } catch (error) {
      expect(error).to.be.instanceOf(DoomainError)
      expect((error as DoomainError).code).to.equal('VERCEL_AUTH_FAILED')
      expect((error as Error).message).to.include('Run `vercel login` again')
    }
  })

  it('does not report domain permission errors as invalid tokens', async () => {
    globalThis.fetch = (async () => errorResponse(403, {error: {message: 'Not authorized to use app.example.com'}})) as typeof fetch

    try {
      await createVercelClient({token: 'vercel_token'}).addDomainToProject('prj_123', 'app.example.com')
      throw new Error('Expected addDomainToProject to fail')
    } catch (error) {
      expect(error).to.be.instanceOf(DoomainError)
      expect((error as DoomainError).code).to.equal('DOMAIN_LINK_FAILED')
      expect((error as Error).message).to.equal('Not authorized to use app.example.com')
    }
  })
})
