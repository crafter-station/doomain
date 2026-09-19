import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'

import { DoomainError } from '../../src/lib/errors.js'
import { installLatestVersion, npmInstallCommand } from '../../src/lib/self-update.js'

describe('self update', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'doomain-update-test-'))
  })

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true })
  })

  function cacheDirectoryFrom(options: { env: NodeJS.ProcessEnv }): string {
    return options.env.npm_config_cache ?? ''
  }

  it('uses npm with a fresh cache and forces an online latest install', async () => {
    let cacheDirectory = ''

    const result = await installLatestVersion({
      cacheRoot: directory,
      platform: 'linux',
      runner: async (command, args, options) => {
        expect(command).to.equal('npm')
        expect(args).to.include.members(['doomain@latest', '--force', '--prefer-online', '--offline=false'])
        cacheDirectory = cacheDirectoryFrom(options)
        expect(cacheDirectory).not.to.equal('')
        expect(existsSync(cacheDirectory)).to.equal(true)
        return { exitCode: 0, stderr: '', stdout: 'updated' }
      },
    })

    expect(result).to.deep.equal({
      package: 'doomain',
      packageManager: 'npm',
      packageSpec: 'doomain@latest',
    })
    expect(existsSync(cacheDirectory)).to.equal(false)
  })

  it('uses the Windows shell to resolve npm on Windows', () => {
    const invocation = npmInstallCommand('C:\\cache', 'win32')

    expect(invocation.command).to.equal('npm')
    expect(invocation.options.shell).to.equal(true)
    expect(invocation.options.env.npm_config_cache).to.equal('C:\\cache')
  })

  it('reports npm failures and removes the temporary cache', async () => {
    let cacheDirectory = ''

    try {
      await installLatestVersion({
        cacheRoot: directory,
        runner: async (_command, _args, options) => {
          cacheDirectory = cacheDirectoryFrom(options)
          return { exitCode: 1, stderr: 'registry unavailable', stdout: '' }
        },
      })
      expect.fail('Expected installLatestVersion to fail')
    } catch (error) {
      expect(error).to.be.instanceOf(DoomainError)
      expect((error as DoomainError).code).to.equal('SELF_UPDATE_FAILED')
      expect((error as Error).message).to.include('registry unavailable')
    }

    expect(existsSync(cacheDirectory)).to.equal(false)
  })
})
