import {expect} from 'chai'

import {planDnsChanges} from '../../src/lib/providers/core/planner.js'

const zone = {id: 'example.com', name: 'example.com'}

describe('planDnsChanges', () => {
  it('skips exact records and creates missing records', () => {
    const plan = planDnsChanges({
      desired: [
        {name: 'app', type: 'CNAME', value: 'cname.vercel-dns.com'},
        {name: 'www', type: 'CNAME', value: 'cname.vercel-dns.com'},
      ],
      existing: [{name: 'app', type: 'CNAME', value: 'cname.vercel-dns.com'}],
      providerId: 'test',
      zone,
    })

    expect(plan.conflicts).to.deep.equal([])
    expect(plan.changes.map((change) => change.action)).to.deep.equal(['skip', 'create'])
  })

  it('reports conflicts unless force is enabled', () => {
    const plan = planDnsChanges({
      desired: [{name: 'app', type: 'CNAME', value: 'cname.vercel-dns.com'}],
      existing: [{name: 'app', type: 'CNAME', value: 'old.example.com'}],
      providerId: 'test',
      zone,
    })

    expect(plan.changes).to.deep.equal([])
    expect(plan.conflicts).to.have.length(1)
  })

  it('plans updates when force is enabled', () => {
    const plan = planDnsChanges({
      desired: [{name: 'app', type: 'CNAME', value: 'cname.vercel-dns.com'}],
      existing: [{name: 'app', type: 'CNAME', value: 'old.example.com'}],
      force: true,
      providerId: 'test',
      zone,
    })

    expect(plan.conflicts).to.deep.equal([])
    expect(plan.changes.map((change) => change.action)).to.deep.equal(['update'])
  })

  it('plans updates when an explicit proxied value differs', () => {
    const plan = planDnsChanges({
      desired: [{name: 'app', proxied: false, type: 'CNAME', value: 'cname.vercel-dns.com'}],
      existing: [{name: 'app', proxied: true, type: 'CNAME', value: 'cname.vercel-dns.com'}],
      providerId: 'cloudflare',
      zone,
    })

    expect(plan.conflicts).to.deep.equal([])
    expect(plan.changes.map((change) => change.action)).to.deep.equal(['update'])
  })

  it('creates additional TXT values at the same name', () => {
    const plan = planDnsChanges({
      desired: [{name: '_vercel', type: 'TXT', value: 'vc-domain-verify=onpe.example.com,new'}],
      existing: [{name: '_vercel', type: 'TXT', value: 'vc-domain-verify=other.example.com,old'}],
      providerId: 'test',
      zone,
    })

    expect(plan.conflicts).to.deep.equal([])
    expect(plan.changes.map((change) => change.action)).to.deep.equal(['create'])
  })

  it('reports CNAME slot conflicts without force', () => {
    const plan = planDnsChanges({
      desired: [{name: 'app', type: 'CNAME', value: 'cname.vercel-dns.com'}],
      existing: [{name: 'app', type: 'A', value: '192.0.2.1'}],
      providerId: 'test',
      zone,
    })

    expect(plan.changes).to.deep.equal([])
    expect(plan.conflicts).to.deep.equal([
      {
        existing: {name: 'app', type: 'A', value: '192.0.2.1'},
        reason: 'cname_slot_conflict',
        record: {name: 'app', type: 'CNAME', value: 'cname.vercel-dns.com'},
      },
    ])
  })

  it('deletes and creates CNAME slot conflicts with force', () => {
    const plan = planDnsChanges({
      desired: [{name: 'app', type: 'CNAME', value: 'cname.vercel-dns.com'}],
      existing: [{name: 'app', type: 'A', value: '192.0.2.1'}],
      force: true,
      providerId: 'test',
      zone,
    })

    expect(plan.conflicts).to.deep.equal([])
    expect(plan.changes).to.deep.equal([
      {action: 'delete', existing: {name: 'app', type: 'A', value: '192.0.2.1'}, reason: 'cname_slot_conflict'},
      {action: 'create', record: {name: 'app', type: 'CNAME', value: 'cname.vercel-dns.com'}},
    ])
  })
})
