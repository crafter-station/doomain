import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'

import type { DoomainEffect } from './effect.js'
import { DoomainError } from './errors.js'

interface ProcessResult {
  exitCode: number | null
  stderr: string
  stdout: string
}

interface ProcessOptions {
  env: NodeJS.ProcessEnv
  shell: boolean
}

type ProcessRunner = (command: string, args: string[], options: ProcessOptions) => DoomainEffect<ProcessResult>

export interface SelfUpdateResult {
  package: string
  packageSpec: string
  packageManager: 'npm'
}

export interface SelfUpdateOptions {
  cacheRoot?: string
  platform?: NodeJS.Platform
  runner?: ProcessRunner
}

function runProcess(command: string, args: string[], options: ProcessOptions): DoomainEffect<ProcessResult> {
  return Effect.async<ProcessResult, DoomainError>((resume) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    let stdout = ''

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.once('error', (cause) =>
      resume(Effect.fail(new DoomainError('SELF_UPDATE_FAILED', `Unable to start npm: ${cause.message}`, cause))),
    )
    child.once('close', (exitCode) => resume(Effect.succeed({ exitCode, stderr, stdout })))
    return Effect.sync(() => child.kill())
  })
}

export function npmInstallCommand(
  cacheDirectory: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): {
  args: string[]
  command: string
  options: ProcessOptions
} {
  const env = Object.fromEntries(
    Object.entries(environment).filter(([key]) => key.toLowerCase() !== 'npm_config_cache'),
  )
  env.npm_config_cache = cacheDirectory

  return {
    command: 'npm',
    args: ['install', '--global', 'doomain@latest', '--prefer-online', '--offline=false'],
    options: {
      env,
      shell: platform === 'win32',
    },
  }
}

export function installLatestVersion(options: SelfUpdateOptions = {}): DoomainEffect<SelfUpdateResult> {
  const acquire = Effect.tryPromise({
    try: () => mkdtemp(join(options.cacheRoot ?? tmpdir(), 'doomain-npm-cache-')),
    catch: (cause) => new DoomainError('SELF_UPDATE_FAILED', `Unable to create npm cache: ${String(cause)}`, cause),
  })

  return Effect.acquireUseRelease(
    acquire,
    (cacheDirectory) =>
      Effect.gen(function* () {
        const invocation = npmInstallCommand(cacheDirectory, options.platform)
        const result = yield* (options.runner ?? runProcess)(invocation.command, invocation.args, invocation.options)

        if (result.exitCode !== 0) {
          const reason =
            result.stderr.trim() || result.stdout.trim() || `npm exited with code ${result.exitCode ?? 'unknown'}`
          return yield* Effect.fail(new DoomainError('SELF_UPDATE_FAILED', `Unable to update doomain: ${reason}`))
        }

        return { package: 'doomain', packageSpec: 'doomain@latest', packageManager: 'npm' as const }
      }),
    (cacheDirectory) =>
      Effect.tryPromise(() => rm(cacheDirectory, { force: true, recursive: true })).pipe(Effect.ignore),
  )
}
