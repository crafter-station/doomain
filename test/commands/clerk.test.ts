import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {runCommand} from '@oclif/test'
import {expect} from 'chai'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {status})
}

function cloudflareResponse(result: unknown) {
  return {errors: [], messages: [], result, 'result_info': {page: 1, 'total_pages': 1}, success: true}
}

describe('clerk domains add', () => {
  const originalFetch = globalThis.fetch
  const env = {...process.env}
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'doomain-clerk-domain-'))
    process.env = {
      ...env,
      CLERK_PLATFORM_API_KEY: 'ak_test',
      CLOUDFLARE_ACCOUNT_ID: 'account_123',
      CLOUDFLARE_API_TOKEN: 'cloudflare_token',
      DOOMAIN_CONFIG_FILE: join(dir, 'config.json'),
    }
    delete process.env.CLERK_APPLICATION_ID
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env = {...env}
    rmSync(dir, {force: true, recursive: true})
  })

  it('aborts when the Clerk application already has production', async () => {
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/v1/platform/applications/app_123') {
        return jsonResponse({
          application_id: 'app_123',
          instances: [
            {environment_type: 'development', instance_id: 'ins_dev', publishable_key: 'pk_test'},
            {environment_type: 'production', instance_id: 'ins_prod', publishable_key: 'pk_live'},
          ],
        })
      }

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const {stdout} = await runCommand('clerk domains add example.com --app app_123 --json')
    const result = JSON.parse(stdout) as {error: {code: string; details: {instanceId: string}}; ok: boolean}

    expect(result.ok).to.equal(false)
    expect(result.error.code).to.equal('CLERK_PRODUCTION_EXISTS')
    expect(result.error.details.instanceId).to.equal('ins_prod')
  })

  it('creates first production, writes DNS-only CNAMEs, and checks Clerk status', async () => {
    const dnsBodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      if (url.hostname === 'api.clerk.com' && url.pathname === '/v1/platform/applications/app_123' && !init?.method) {
        return jsonResponse({
          application_id: 'app_123',
          instances: [{environment_type: 'development', instance_id: 'ins_dev', publishable_key: 'pk_test'}],
        })
      }

      if (url.hostname === 'api.cloudflare.com' && url.pathname === '/client/v4/zones') {
        return jsonResponse(cloudflareResponse([{id: 'zone_1', name: 'example.com'}]))
      }

      if (url.hostname === 'api.clerk.com' && url.pathname === '/v1/platform/applications/app_123/instances') {
        expect(JSON.parse(String(init?.body))).to.deep.equal({clone_instance_id: 'ins_dev', domain: 'example.com', environment_type: 'production'})
        return jsonResponse(
          {
            active_domain: {
              cname_targets: [
                {host: 'clerk.example.com', required: true, value: 'frontend-api.clerk.services'},
                {host: 'accounts.example.com', required: true, value: 'accounts.clerk.services'},
              ],
              frontend_api_url: 'https://clerk.example.com',
              id: 'dmn_123',
              is_satellite: false,
              name: 'example.com',
            },
            environment_type: 'production',
            id: 'ins_prod',
            publishable_key: 'pk_live',
          },
          201,
        )
      }

      if (url.hostname === 'api.cloudflare.com' && url.pathname === '/client/v4/zones/zone_1/dns_records' && !init?.method) {
        return jsonResponse(cloudflareResponse([]))
      }

      if (url.hostname === 'api.cloudflare.com' && url.pathname === '/client/v4/zones/zone_1/dns_records' && init?.method === 'POST') {
        dnsBodies.push(JSON.parse(String(init.body)))
        return jsonResponse(cloudflareResponse({content: 'target', id: `record_${dnsBodies.length}`, name: 'record.example.com', type: 'CNAME'}))
      }

      if (url.hostname === 'api.clerk.com' && url.pathname.endsWith('/dns_check')) {
        return jsonResponse({status: 'incomplete'})
      }

      if (url.hostname === 'api.clerk.com' && url.pathname.endsWith('/status')) {
        return jsonResponse({dns: {status: 'complete'}, mail: {required: true, status: 'complete'}, ssl: {required: true, status: 'complete'}, status: 'complete'})
      }

      throw new Error(`Unexpected request: ${url.href}`)
    }) as typeof fetch

    const {stdout} = await runCommand('clerk domains add example.com --app app_123 --provider cloudflare --json')
    const result = JSON.parse(stdout) as {
      data: {clerk: {productionInstanceCreated: boolean; verified: boolean}; nextSteps: string[]; records: Array<{name: string; proxied: boolean}>}
      ok: boolean
    }

    expect(result.ok).to.equal(true)
    expect(result.data.clerk.productionInstanceCreated).to.equal(true)
    expect(result.data.clerk.verified).to.equal(true)
    expect(result.data.records).to.deep.include({name: 'clerk', proxied: false, ttl: 300, type: 'CNAME', value: 'frontend-api.clerk.services'})
    expect(dnsBodies).to.deep.include({content: 'frontend-api.clerk.services', name: 'clerk.example.com', proxied: false, ttl: 300, type: 'CNAME'})
    expect(result.data.nextSteps).to.include('clerk env pull --app app_123 --instance prod')
  })
})
