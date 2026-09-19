import { strict as assert } from 'node:assert'
import { describe, it } from 'mocha'

import { tryPromise } from '../../src/lib/effect.js'
import { DoomainError } from '../../src/lib/errors.js'
import { createProvider } from '../../src/lib/providers/registry.js'
import { runEffect } from '../helpers/effect.js'

describe('Doomain Effect helpers', () => {
  it('maps rejected Promise boundaries to the requested fallback code', async () => {
    await assert.rejects(
      runEffect(tryPromise(() => Promise.reject(new Error('prompt failed')), 'DNS_POINT_FAILED')),
      (error: unknown) =>
        error instanceof DoomainError && error.code === 'DNS_POINT_FAILED' && error.message === 'prompt failed',
    )
  })

  it('preserves typed failures rejected across Promise boundaries', async () => {
    await assert.rejects(
      runEffect(
        tryPromise(() => Promise.reject(new DoomainError('DNS_TARGET_CONFLICT', 'DNS conflict')), 'DNS_POINT_FAILED'),
      ),
      (error: unknown) => error instanceof DoomainError && error.code === 'DNS_TARGET_CONFLICT',
    )
  })

  it('keeps synchronous provider account validation in the typed channel', async () => {
    await assert.rejects(
      runEffect(createProvider('spaceship', { account: 'bad account' })),
      (error: unknown) => error instanceof DoomainError && error.code === 'INVALID_INPUT',
    )
  })
})
