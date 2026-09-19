import { strict as assert } from 'node:assert'
import { describe, it } from 'mocha'

import { desiredSlotPostcondition, recordMatchesSelector } from '../../src/lib/dns-records.js'

describe('DNS record postconditions', () => {
  it('requires requested TTL and proxy options to match', () => {
    const records = [{ name: 'app', proxied: true, ttl: 3600, type: 'A' as const, value: '203.0.113.10' }]
    const desired = {
      name: 'app',
      proxied: false,
      ttl: 300,
      type: 'A' as const,
      value: '203.0.113.10',
    }

    assert.equal(desiredSlotPostcondition(records, desired).reconciled, false)
    assert.equal(desiredSlotPostcondition([{ ...records[0], proxied: false, ttl: 300 }], desired).reconciled, true)
  })

  it('matches DNS owner names case-insensitively', () => {
    assert.equal(
      recordMatchesSelector(
        { name: 'WWW.', type: 'A', value: '203.0.113.10' },
        { name: 'www', type: 'A', value: '203.0.113.10' },
      ),
      true,
    )
    assert.equal(
      desiredSlotPostcondition([{ name: 'WWW.', type: 'A', value: '203.0.113.10' }], {
        name: 'www',
        type: 'A',
        value: '203.0.113.10',
      }).reconciled,
      true,
    )
  })
})
