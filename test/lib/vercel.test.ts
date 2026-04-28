import {expect} from 'chai'

import {createVercelClient} from '../../src/lib/vercel.js'

function jsonResponse(body: unknown): Response {
  return {json: async () => body, ok: true, status: 200} as Response
}

describe('vercel client', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
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
})
