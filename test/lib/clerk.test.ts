import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'

import {
  createClerkPlatformClient as createClerkEffectClient,
  resolveClerkPlatformConfig as resolveClerkPlatformConfigEffect,
} from '../../src/lib/clerk.js'
import { saveConfig as saveConfigEffect } from '../../src/lib/config.js'
import { DoomainError } from '../../src/lib/errors.js'
import { runEffect } from '../helpers/effect.js'

const saveConfig = (...args: Parameters<typeof saveConfigEffect>) => runEffect(saveConfigEffect(...args))
const resolveClerkPlatformConfig = (...args: Parameters<typeof resolveClerkPlatformConfigEffect>) =>
  runEffect(resolveClerkPlatformConfigEffect(...args))
const createClerkPlatformClient = (...args: Parameters<typeof createClerkEffectClient>) => {
  const client = createClerkEffectClient(...args)
  return {
    createProductionInstance: (...methodArgs: Parameters<typeof client.createProductionInstance>) =>
      runEffect(client.createProductionInstance(...methodArgs)),
    fetchApplication: (...methodArgs: Parameters<typeof client.fetchApplication>) =>
      runEffect(client.fetchApplication(...methodArgs)),
  }
}

describe('clerk platform client', () => {
  const originalFetch = globalThis.fetch
  const env = { ...process.env }
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'doomain-clerk-client-'))
    process.env = { ...env, DOOMAIN_CONFIG_FILE: join(dir, 'config.json') }
    delete process.env.CLERK_APPLICATION_ID
    delete process.env.CLERK_PLATFORM_API_KEY
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env = { ...env }
    rmSync(dir, { force: true, recursive: true })
  })

  it('prefers environment credentials over saved Clerk config', async () => {
    await saveConfig({ clerk: { appId: 'app_saved', platformApiKey: 'ak_saved' } })
    process.env.CLERK_APPLICATION_ID = 'app_env'
    process.env.CLERK_PLATFORM_API_KEY = 'ak_env'

    expect(await resolveClerkPlatformConfig()).to.deep.equal({ appId: 'app_env', platformApiKey: 'ak_env' })
  })

  it('creates a production instance through the Clerk Platform API', async () => {
    let request: RequestInit | undefined
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).to.equal('https://api.clerk.com/v1/platform/applications/app_123/instances')
      request = init
      return new Response(
        JSON.stringify({
          id: 'ins_prod',
          environment_type: 'production',
          active_domain: null,
          publishable_key: 'pk_live',
        }),
        {
          status: 201,
        },
      )
    }) as typeof fetch

    await createClerkPlatformClient({ platformApiKey: 'ak_test' }).createProductionInstance(
      'app_123',
      'example.com',
      'ins_dev',
    )

    expect(request?.method).to.equal('POST')
    expect(new Headers(request?.headers).get('Authorization')).to.equal('Bearer ak_test')
    expect(JSON.parse(String(request?.body))).to.deep.equal({
      clone_instance_id: 'ins_dev',
      domain: 'example.com',
      environment_type: 'production',
    })
  })

  it('returns an actionable Clerk authorization error', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ message: 'Forbidden' }] }), { status: 403 })) as typeof fetch

    let error: unknown
    try {
      await createClerkPlatformClient({ platformApiKey: 'ak_bad' }).fetchApplication('app_123')
    } catch (caught) {
      error = caught
    }

    expect(error).to.be.instanceOf(DoomainError)
    expect((error as DoomainError).code).to.equal('CLERK_AUTH_FAILED')
    expect((error as Error).message).to.include('CLERK_PLATFORM_API_KEY')
  })

  it('preserves the Clerk auth error for a non-JSON authorization response', async () => {
    globalThis.fetch = (async () => new Response('Forbidden', { status: 403 })) as typeof fetch

    let error: unknown
    try {
      await createClerkPlatformClient({ platformApiKey: 'ak_bad' }).fetchApplication('app_123')
    } catch (caught) {
      error = caught
    }

    expect(error).to.be.instanceOf(DoomainError)
    expect((error as DoomainError).code).to.equal('CLERK_AUTH_FAILED')
    expect((error as Error).message).to.include('Clerk API error (403)')
  })

  it('uses the caller transport error code for network failures', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network unavailable')
    }) as typeof fetch

    let error: unknown
    try {
      await createClerkPlatformClient(
        { platformApiKey: 'ak_test' },
        { transportErrorCode: 'CLERK_AUTH_FAILED' },
      ).fetchApplication('app_123')
    } catch (caught) {
      error = caught
    }

    expect(error).to.be.instanceOf(DoomainError)
    expect((error as DoomainError).code).to.equal('CLERK_AUTH_FAILED')
    expect((error as Error).message).to.equal('network unavailable')
  })

  it('uses the caller transport error code for malformed successful responses', async () => {
    globalThis.fetch = (async () => new Response('not json', { status: 200 })) as typeof fetch

    let error: unknown
    try {
      await createClerkPlatformClient(
        { platformApiKey: 'ak_test' },
        { transportErrorCode: 'CLERK_AUTH_FAILED' },
      ).fetchApplication('app_123')
    } catch (caught) {
      error = caught
    }

    expect(error).to.be.instanceOf(DoomainError)
    expect((error as DoomainError).code).to.equal('CLERK_AUTH_FAILED')
  })
})
