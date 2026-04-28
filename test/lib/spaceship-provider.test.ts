import {expect} from 'chai'

import {createProvider} from '../../src/lib/providers/registry.js'

describe('spaceship provider', () => {
  const originalFetch = globalThis.fetch
  const originalApiKey = process.env.SPACESHIP_API_KEY
  const originalApiSecret = process.env.SPACESHIP_API_SECRET

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalApiKey === undefined) delete process.env.SPACESHIP_API_KEY
    else process.env.SPACESHIP_API_KEY = originalApiKey
    if (originalApiSecret === undefined) delete process.env.SPACESHIP_API_SECRET
    else process.env.SPACESHIP_API_SECRET = originalApiSecret
  })

  it('lists Spaceship domains from the paginated API', async () => {
    process.env.SPACESHIP_API_KEY = 'key'
    process.env.SPACESHIP_API_SECRET = 'secret'
    const requestedSkips: string[] = []

    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))
      const skip = url.searchParams.get('skip') ?? '0'
      requestedSkips.push(skip)

      return {
        ok: true,
        status: 200,
        json: async () =>
          skip === '0'
            ? {items: [{name: 'alpha.com'}, {unicodeName: 'beta.com'}], total: 3}
            : {items: [{name: 'gamma.com'}], total: 3},
      } as Response
    }) as typeof fetch

    const provider = await createProvider('spaceship')
    const zones = await provider.listZones()

    expect(requestedSkips).to.deep.equal(['0', '2'])
    expect(zones).to.deep.equal([
      {id: 'alpha.com', name: 'alpha.com'},
      {id: 'beta.com', name: 'beta.com'},
      {id: 'gamma.com', name: 'gamma.com'},
    ])
  })
})
