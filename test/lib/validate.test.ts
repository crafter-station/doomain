import {expect} from 'chai'

import {resolveDomainTarget} from '../../src/lib/validate.js'

describe('resolveDomainTarget', () => {
  it('builds a subdomain target', () => {
    expect(resolveDomainTarget({domain: 'Example.com/', subdomain: 'App'})).to.deep.equal({
      fullDomain: 'app.example.com',
      isApex: false,
      recordName: 'app',
      zoneDomain: 'example.com',
    })
  })

  it('builds an apex target', () => {
    expect(resolveDomainTarget({domain: 'example.com', apex: true})).to.deep.equal({
      fullDomain: 'example.com',
      isApex: true,
      recordName: '@',
      zoneDomain: 'example.com',
    })
  })
})
