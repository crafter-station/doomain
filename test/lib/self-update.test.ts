import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { Effect } from 'effect'

import { DoomainError } from '../../src/lib/errors.js'
import { installLatestVersion, npmInstallCommand } from '../../src/lib/self-update.js'
import { runEffect } from '../helpers/effect.js'

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

    const result = await runEffect(
      installLatestVersion({
        cacheRoot: directory,
        platform: 'linux',
        runner: (command, args, options) =>
          Effect.sync(() => {
            expect(command).to.equal('npm')
            expect(args).to.include.members(['doomain@latest', '--prefer-online', '--offline=false'])
            expect(args).not.to.include('--force')
            cacheDirectory = cacheDirectoryFrom(options)
            expect(cacheDirectory).not.to.equal('')
            expect(existsSync(cacheDirectory)).to.equal(true)
            return { exitCode: 0, stderr: '', stdout: 'updated' }
          }),
      }),
    )

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

  it('removes inherited cache settings regardless of environment key casing', () => {
    const invocation = npmInstallCommand('/fresh-cache', 'win32', {
      NPM_CONFIG_CACHE: 'C:\\old-cache',
      npm_config_cache: 'C:\\another-old-cache',
      PATH: 'C:\\bin',
    })

    expect(invocation.options.env).to.deep.equal({
      npm_config_cache: '/fresh-cache',
      PATH: 'C:\\bin',
    })
  })

  it('reports npm failures and removes the temporary cache', async () => {
    let cacheDirectory = ''

    try {
      await runEffect(
        installLatestVersion({
          cacheRoot: directory,
          runner: (_command, _args, options) =>
            Effect.sync(() => {
              cacheDirectory = cacheDirectoryFrom(options)
              return { exitCode: 1, stderr: 'registry unavailable', stdout: '' }
            }),
        }),
      )
      expect.fail('Expected installLatestVersion to fail')
    } catch (error) {
      expect(error).to.be.instanceOf(DoomainError)
      expect((error as DoomainError).code).to.equal('SELF_UPDATE_FAILED')
      expect((error as Error).message).to.include('registry unavailable')
    }

    expect(existsSync(cacheDirectory)).to.equal(false)
  })
})
