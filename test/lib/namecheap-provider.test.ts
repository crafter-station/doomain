import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect} from 'chai'

import {createProvider} from '../../src/lib/providers/registry.js'

const domainListXml = `<?xml version="1.0" encoding="UTF-8"?>
<ApiResponse Status="OK">
  <CommandResponse>
    <DomainGetListResult>
      <Domain Name="example.com" />
    </DomainGetListResult>
    <Paging TotalItems="1" />
  </CommandResponse>
</ApiResponse>`

const hostsXml = `<?xml version="1.0" encoding="UTF-8"?>
<ApiResponse Status="OK">
  <CommandResponse>
    <DomainDNSGetHostsResult>
      <host HostId="1" Name="@" Type="A" Address="1.1.1.1" TTL="1800" />
      <host HostId="2" Name="mail" Type="MX" Address="mail.example.com" MXPref="10" TTL="1800" />
    </DomainDNSGetHostsResult>
  </CommandResponse>
</ApiResponse>`

const okXml = `<?xml version="1.0" encoding="UTF-8"?>
<ApiResponse Status="OK">
  <CommandResponse>
    <DomainDNSSetHostsResult Domain="example.com" IsSuccess="true" />
  </CommandResponse>
</ApiResponse>`

const failedSetHostsXml = `<?xml version="1.0" encoding="UTF-8"?>
<ApiResponse Status="OK">
  <CommandResponse>
    <DomainDNSSetHostsResult Domain="example.com" IsSuccess="false" />
  </CommandResponse>
</ApiResponse>`

function namecheapParams(input: RequestInfo | URL, init?: RequestInit): URLSearchParams {
  const url = new URL(String(input))
  return url.search ? url.searchParams : new URLSearchParams(String(init?.body ?? ''))
}

describe('namecheap provider', () => {
  const originalFetch = globalThis.fetch
  const env = {...process.env}

  beforeEach(() => {
    process.env.NAMECHEAP_API_USER = 'user'
    process.env.NAMECHEAP_API_KEY = 'key'
    process.env.NAMECHEAP_CLIENT_IP = '127.0.0.1'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env = {...env}
  })

  it('lists domains from Namecheap XML', async () => {
    globalThis.fetch = (async () => ({ok: true, status: 200, text: async () => domainListXml}) as Response) as typeof fetch

    const provider = await createProvider('namecheap')
    const zones = await provider.listZones()

    expect(zones).to.deep.equal([{id: 'example.com', name: 'example.com'}])
  })

  it('lists DNS host records from Namecheap XML', async () => {
    globalThis.fetch = (async () => ({ok: true, status: 200, text: async () => hostsXml}) as Response) as typeof fetch

    const provider = await createProvider('namecheap')
    const records = await provider.listRecords({id: 'example.com', name: 'example.com'})

    expect(records).to.deep.equal([
      {id: '1', metadata: {namecheap: {Address: '1.1.1.1', HostId: '1', Name: '@', TTL: '1800', Type: 'A'}}, name: '@', ttl: 1800, type: 'A', value: '1.1.1.1'},
      {
        id: '2',
        metadata: {namecheap: {Address: 'mail.example.com', HostId: '2', MXPref: '10', Name: 'mail', TTL: '1800', Type: 'MX'}},
        name: 'mail',
        priority: 10,
        ttl: 1800,
        type: 'MX',
        value: 'mail.example.com',
      },
    ])
  })

  it('preserves unrelated records when applying setHosts', async () => {
    const requests: Array<{init?: RequestInit; input: RequestInfo | URL}> = []
    globalThis.fetch = (async (input, init) => {
      requests.push({init, input})
      const command = namecheapParams(input, init).get('Command')
      return {ok: true, status: 200, text: async () => (command === 'namecheap.domains.dns.setHosts' ? okXml : hostsXml)} as Response
    }) as typeof fetch

    const provider = await createProvider('namecheap')
    const zone = {id: 'example.com', name: 'example.com'}
    const plan = await provider.planChanges(zone, [{name: 'app', type: 'CNAME', value: 'cname.vercel-dns.com', ttl: 1800}])
    await provider.applyChanges(zone, plan)

    const setHostsRequest = requests.find((request) => namecheapParams(request.input, request.init).get('Command') === 'namecheap.domains.dns.setHosts')!
    const setHostsParams = namecheapParams(setHostsRequest.input, setHostsRequest.init)
    expect(setHostsRequest.init?.method).to.equal('POST')
    expect(String(setHostsRequest.input)).to.equal('https://api.namecheap.com/xml.response')
    expect(setHostsParams.get('HostName1')).to.equal('@')
    expect(setHostsParams.get('RecordType1')).to.equal('A')
    expect(setHostsParams.get('HostName2')).to.equal('mail')
    expect(setHostsParams.get('RecordType2')).to.equal('MX')
    expect(setHostsParams.get('MXPref2')).to.equal('10')
    expect(setHostsParams.get('HostName3')).to.equal('app')
    expect(setHostsParams.get('RecordType3')).to.equal('CNAME')
  })

  it('throws when setHosts does not confirm success', async () => {
    globalThis.fetch = (async (input, init) => {
      const command = namecheapParams(input, init).get('Command')
      return {ok: true, status: 200, text: async () => (command === 'namecheap.domains.dns.setHosts' ? failedSetHostsXml : hostsXml)} as Response
    }) as typeof fetch

    const provider = await createProvider('namecheap')
    const zone = {id: 'example.com', name: 'example.com'}
    const plan = await provider.planChanges(zone, [{name: 'app', type: 'CNAME', value: 'cname.vercel-dns.com', ttl: 1800}])
    let error: unknown

    try {
      await provider.applyChanges(zone, plan)
    } catch (error_) {
      error = error_
    }

    expect(error).to.be.instanceOf(Error)
    expect((error as Error).message).to.equal('Namecheap did not confirm DNS host records were updated.')
  })

  it('does not save invalid provider credentials when verification fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doomain-namecheap-'))
    const configFile = join(dir, 'config.json')
    process.env.DOOMAIN_CONFIG_FILE = configFile
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => '<ApiResponse Status="ERROR"><Errors><Error>API key is invalid</Error></Errors></ApiResponse>',
    }) as Response) as typeof fetch

    try {
      const {runCommand} = await import('@oclif/test')
      const result = await runCommand('providers connect namecheap --credential apiUser=user --credential apiKey=bad --credential clientIp=127.0.0.1 --json')
      const output = JSON.parse(result.stdout) as {ok: boolean}

      expect(output.ok).to.equal(false)
      expect(() => readFileSync(configFile, 'utf8')).to.throw()
    } finally {
      rmSync(dir, {force: true, recursive: true})
    }
  })
})
