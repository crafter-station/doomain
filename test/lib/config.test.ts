import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'mocha'

import { saveConfig } from '../../src/lib/config.js'
import { DoomainError } from '../../src/lib/errors.js'
import { runEffect } from '../helpers/effect.js'

describe('config', () => {
  const originalEnv = { ...process.env }
  const temporaryDirectories: string[] = []

  afterEach(() => {
    process.env = { ...originalEnv }
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true })
  })

  it('uses the caller error code when the config cannot be written', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'doomain-config-error-'))
    temporaryDirectories.push(directory)
    const blockingFile = join(directory, 'not-a-directory')
    writeFileSync(blockingFile, '')
    process.env.DOOMAIN_CONFIG_FILE = join(blockingFile, 'config.json')

    await assert.rejects(
      runEffect(saveConfig({}, 'CLERK_AUTH_FAILED')),
      (error: unknown) => error instanceof DoomainError && error.code === 'CLERK_AUTH_FAILED',
    )
  })
})
