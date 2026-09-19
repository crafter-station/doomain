import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { expect } from 'chai'

const devBin = fileURLToPath(new URL('../../bin/dev.js', import.meta.url))

function invokeCli(args: string[]) {
  const result = spawnSync(process.execPath, ['--loader', 'ts-node/esm', devBin, ...args], {
    encoding: 'utf8',
  })

  return result
}

function runCli(args: string[]): string {
  const result = invokeCli(args)

  expect(result.status, result.stderr).to.equal(0)
  return result.stdout
}

describe('standard CLI commands and flags', () => {
  it('supports long and short root help flags', () => {
    for (const flag of ['--help', '-h']) {
      const stdout = runCli([flag])

      expect(stdout).to.include('USAGE')
      expect(stdout).to.include('$ doomain [COMMAND]')
    }
  })

  it('supports long and short help flags after a command', () => {
    for (const flag of ['--help', '-h']) {
      const stdout = runCli(['link', flag])

      expect(stdout).to.include('Link a Vercel project to a domain')
      expect(stdout).to.include('$ doomain link [DOMAIN]')
    }
  })

  it('supports long and short version flags plus a version command', () => {
    for (const args of [['--version'], ['-v'], ['version']]) {
      expect(runCli(args)).to.match(/^doomain\/\d+\.\d+\.\d+ /)
    }
  })

  it('rejects unknown version command flags', () => {
    const result = invokeCli(['version', '--unknown'])

    expect(result.status).to.equal(2)
    expect(result.stderr).to.include('Nonexistent flag: --unknown')
  })
})
