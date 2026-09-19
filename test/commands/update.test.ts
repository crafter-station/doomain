import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { runCommand } from '@oclif/test'
import { expect } from 'chai'

describe('update commands', () => {
  const env = { ...process.env }
  let directory: string
  let invocationFile: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'doomain-update-command-'))
    invocationFile = join(directory, 'npm-invocation.json')
    const fakeNpm = `require('node:fs').writeFileSync(process.env.DOOMAIN_TEST_NPM_INVOCATION, JSON.stringify(process.argv.slice(2)))\n`

    writeFileSync(join(directory, 'npm'), `#!/usr/bin/env node\n${fakeNpm}`, { mode: 0o755 })
    writeFileSync(join(directory, 'fake-npm.cjs'), fakeNpm)
    writeFileSync(join(directory, 'npm.cmd'), '@node "%~dp0fake-npm.cjs" %*\r\n')
    chmodSync(join(directory, 'npm'), 0o755)
    process.env.PATH = `${directory}${delimiter}${env.PATH ?? ''}`
    process.env.DOOMAIN_TEST_NPM_INVOCATION = invocationFile
  })

  afterEach(() => {
    process.env = { ...env }
    rmSync(directory, { force: true, recursive: true })
  })

  for (const command of ['update', 'upgrade']) {
    it(`updates through ${command}`, async () => {
      const { stdout } = await runCommand(`${command} --json`)
      const result = JSON.parse(stdout) as {
        data: { package: string; packageManager: string; packageSpec: string }
        ok: boolean
      }
      const args = JSON.parse(readFileSync(invocationFile, 'utf8')) as string[]

      expect(args).to.include.members(['doomain@latest', '--force', '--prefer-online', '--offline=false'])
      expect(result).to.deep.equal({
        data: { package: 'doomain', packageManager: 'npm', packageSpec: 'doomain@latest' },
        ok: true,
      })
    })
  }
})
