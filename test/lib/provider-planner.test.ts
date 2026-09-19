import { expect } from 'chai'

import { planDnsChanges } from '../../src/lib/providers/core/planner.js'

const zone = { id: 'example.com', name: 'example.com' }

describe('planDnsChanges', () => {
  it('skips exact records and creates missing records', () => {
    const plan = planDnsChanges({
      desired: [
        { name: 'app', type: 'CNAME', value: 'cname.vercel-dns.com' },
        { name: 'www', type: 'CNAME', value: 'cname.vercel-dns.com' },
      ],
      existing: [{ name: 'app', type: 'CNAME', value: 'cname.vercel-dns.com' }],
      providerId: 'test',
      zone,
    })

    expect(plan.conflicts).to.deep.equal([])
    expect(plan.changes.map((change) => change.action)).to.deep.equal(['skip', 'create'])
  })

  it('reports conflicts unless force is enabled', () => {
    const plan = planDnsChanges({
      desired: [{ name: 'app', type: 'CNAME', value: 'cname.vercel-dns.com' }],
      existing: [{ name: 'app', type: 'CNAME', value: 'old.example.com' }],
      providerId: 'test',
      zone,
    })

    expect(plan.changes).to.deep.equal([])
    expect(plan.conflicts).to.have.length(1)
  })

  it('plans updates when force is enabled', () => {
    const plan = planDnsChanges({
      desired: [{ name: 'app', type: 'CNAME', value: 'cname.vercel-dns.com' }],
      existing: [{ name: 'app', type: 'CNAME', value: 'old.example.com' }],
      force: true,
      providerId: 'test',
      zone,
    })

    expect(plan.conflicts).to.deep.equal([])
    expect(plan.changes.map((change) => change.action)).to.deep.equal(['update'])
  })

  it('reports every conflicting same-type record', () => {
    const plan = planDnsChanges({
      desired: [{ name: 'app', type: 'A', value: '203.0.113.10' }],
      existing: [
        { id: 'old-1', name: 'app', type: 'A', value: '192.0.2.1' },
        { id: 'old-2', name: 'app', type: 'A', value: '192.0.2.2' },
      ],
      providerId: 'test',
      zone,
    })

    expect(plan.changes).to.deep.equal([])
    expect(plan.conflicts.map((conflict) => conflict.existing.value)).to.deep.equal(['192.0.2.1', '192.0.2.2'])
  })

  it('replaces one and removes remaining same-type records with force', () => {
    const plan = planDnsChanges({
      desired: [{ name: 'app', type: 'A', value: '203.0.113.10' }],
      existing: [
        { id: 'old-1', name: 'app', type: 'A', value: '192.0.2.1' },
        { id: 'old-2', name: 'app', type: 'A', value: '192.0.2.2' },
      ],
      force: true,
      providerId: 'test',
      zone,
    })

    expect(plan.conflicts).to.deep.equal([])
    expect(plan.changes).to.deep.equal([
      {
        action: 'update',
        existing: { id: 'old-1', name: 'app', type: 'A', value: '192.0.2.1' },
        record: { name: 'app', type: 'A', value: '203.0.113.10' },
      },
      {
        action: 'delete',
        existing: { id: 'old-2', name: 'app', type: 'A', value: '192.0.2.2' },
        reason: 'same_type_record_exists',
      },
    ])
  })

  it('removes stale same-type records when the desired record already exists', () => {
    const plan = planDnsChanges({
      desired: [{ name: 'app', type: 'A', value: '203.0.113.10' }],
      existing: [
        { id: 'exact', name: 'app', type: 'A', value: '203.0.113.10' },
        { id: 'old', name: 'app', type: 'A', value: '192.0.2.1' },
      ],
      force: true,
      providerId: 'test',
      zone,
    })

    expect(plan.conflicts).to.deep.equal([])
    expect(plan.changes).to.deep.equal([
      {
        action: 'delete',
        existing: { id: 'old', name: 'app', type: 'A', value: '192.0.2.1' },
        reason: 'same_type_record_exists',
      },
      {
        action: 'skip',
        existing: { id: 'exact', name: 'app', type: 'A', value: '203.0.113.10' },
        reason: 'already_exists',
        record: { name: 'app', type: 'A', value: '203.0.113.10' },
      },
    ])
  })

  it('plans updates when an explicit proxied value differs', () => {
    const plan = planDnsChanges({
      desired: [{ name: 'app', proxied: false, type: 'CNAME', value: 'cname.vercel-dns.com' }],
      existing: [{ name: 'app', proxied: true, type: 'CNAME', value: 'cname.vercel-dns.com' }],
      providerId: 'cloudflare',
      zone,
    })

    expect(plan.conflicts).to.deep.equal([])
    expect(plan.changes.map((change) => change.action)).to.deep.equal(['update'])
  })

  it('updates an existing value when its requested TTL differs', () => {
    const plan = planDnsChanges({
      desired: [{ name: 'app', ttl: 300, type: 'A', value: '203.0.113.10' }],
      existing: [{ id: 'existing', name: 'app', ttl: 3600, type: 'A', value: '203.0.113.10' }],
      providerId: 'test',
      zone,
    })

    expect(plan.conflicts).to.deep.equal([])
    expect(plan.changes).to.deep.equal([
      {
        action: 'update',
        existing: { id: 'existing', name: 'app', ttl: 3600, type: 'A', value: '203.0.113.10' },
        record: { name: 'app', ttl: 300, type: 'A', value: '203.0.113.10' },
      },
    ])
  })

  it('creates additional TXT values at the same name', () => {
    const plan = planDnsChanges({
      desired: [{ name: '_vercel', type: 'TXT', value: 'vc-domain-verify=onpe.example.com,new' }],
      existing: [{ name: '_vercel', type: 'TXT', value: 'vc-domain-verify=other.example.com,old' }],
      providerId: 'test',
      zone,
    })

    expect(plan.conflicts).to.deep.equal([])
    expect(plan.changes.map((change) => change.action)).to.deep.equal(['create'])
  })

  it('reports CNAME slot conflicts without force', () => {
    const plan = planDnsChanges({
      desired: [{ name: 'app', type: 'CNAME', value: 'cname.vercel-dns.com' }],
      existing: [{ name: 'app', type: 'A', value: '192.0.2.1' }],
      providerId: 'test',
      zone,
    })

    expect(plan.changes).to.deep.equal([])
    expect(plan.conflicts).to.deep.equal([
      {
        existing: { name: 'app', type: 'A', value: '192.0.2.1' },
        reason: 'cname_slot_conflict',
        record: { name: 'app', type: 'CNAME', value: 'cname.vercel-dns.com' },
      },
    ])
  })

  it('deletes and creates CNAME slot conflicts with force', () => {
    const plan = planDnsChanges({
      desired: [{ name: 'app', type: 'CNAME', value: 'cname.vercel-dns.com' }],
      existing: [{ name: 'app', type: 'A', value: '192.0.2.1' }],
      force: true,
      providerId: 'test',
      zone,
    })

    expect(plan.conflicts).to.deep.equal([])
    expect(plan.changes).to.deep.equal([
      { action: 'delete', existing: { name: 'app', type: 'A', value: '192.0.2.1' }, reason: 'cname_slot_conflict' },
      { action: 'create', record: { name: 'app', type: 'CNAME', value: 'cname.vercel-dns.com' } },
    ])
  })

  it('deletes every conflicting record before creating a CNAME with force', () => {
    const plan = planDnsChanges({
      desired: [{ name: 'app', type: 'CNAME', value: 'origin.example.net' }],
      existing: [
        { id: 'ipv4', name: 'app', type: 'A', value: '192.0.2.1' },
        { id: 'ipv6', name: 'app', type: 'AAAA', value: '2001:db8::1' },
      ],
      force: true,
      providerId: 'test',
      zone,
    })

    expect(plan.conflicts).to.deep.equal([])
    expect(plan.changes).to.deep.equal([
      {
        action: 'delete',
        existing: { id: 'ipv4', name: 'app', type: 'A', value: '192.0.2.1' },
        reason: 'cname_slot_conflict',
      },
      {
        action: 'delete',
        existing: { id: 'ipv6', name: 'app', type: 'AAAA', value: '2001:db8::1' },
        reason: 'cname_slot_conflict',
      },
      { action: 'create', record: { name: 'app', type: 'CNAME', value: 'origin.example.net' } },
    ])
  })
})
