import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

type ProcessRunner = (command: string, args: string[], options: ProcessOptions) => Promise<ProcessResult>

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

function runProcess(command: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
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
    child.once('error', reject)
    child.once('close', (exitCode) => resolve({ exitCode, stderr, stdout }))
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

export async function installLatestVersion(options: SelfUpdateOptions = {}): Promise<SelfUpdateResult> {
  const cacheDirectory = await mkdtemp(join(options.cacheRoot ?? tmpdir(), 'doomain-npm-cache-'))

  try {
    const invocation = npmInstallCommand(cacheDirectory, options.platform)
    const result = await (options.runner ?? runProcess)(invocation.command, invocation.args, invocation.options)

    if (result.exitCode !== 0) {
      const reason =
        result.stderr.trim() || result.stdout.trim() || `npm exited with code ${result.exitCode ?? 'unknown'}`
      throw new DoomainError('SELF_UPDATE_FAILED', `Unable to update doomain: ${reason}`)
    }

    return {
      package: 'doomain',
      packageSpec: 'doomain@latest',
      packageManager: 'npm',
    }
  } catch (error) {
    if (error instanceof DoomainError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new DoomainError('SELF_UPDATE_FAILED', `Unable to update doomain: ${message}`)
  } finally {
    await rm(cacheDirectory, { force: true, recursive: true }).catch(() => undefined)
  }
}
