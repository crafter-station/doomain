import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Effect } from 'effect'

import type { DoomainEffect } from './effect.js'
import { DoomainError } from './errors.js'

export function getConfigDir(): string {
  return process.env.DOOMAIN_CONFIG_DIR || join(homedir(), '.doomain')
}

export function getConfigFile(): string {
  return process.env.DOOMAIN_CONFIG_FILE || join(getConfigDir(), 'config.json')
}

export const CONFIG_DIR = getConfigDir()
export const CONFIG_FILE = getConfigFile()

export interface VercelConfig {
  token?: string
  teamId?: string
}

export interface ClerkConfig {
  appId?: string
  platformApiKey?: string
}

export interface ProviderAccountConfig {
  credentials?: Record<string, string>
  settings?: Record<string, unknown>
}

export interface ProviderConfig extends ProviderAccountConfig {
  accounts?: Record<string, ProviderAccountConfig | undefined>
}

export interface SpaceshipProviderConfig extends ProviderConfig {
  apiKey?: string
  apiSecret?: string
  domains?: string[]
}

export interface DoomainConfig {
  clerk?: ClerkConfig
  vercel?: VercelConfig
  providers?: {
    spaceship?: SpaceshipProviderConfig
    [provider: string]: ProviderConfig | SpaceshipProviderConfig | undefined
  }
  defaults?: {
    project?: string
    provider?: string
    domain?: string
  }
}

export function loadConfig(): DoomainEffect<DoomainConfig, never> {
  return Effect.tryPromise(() => readFile(getConfigFile(), 'utf8')).pipe(
    Effect.flatMap((data) => Effect.try(() => JSON.parse(data) as DoomainConfig)),
    Effect.catchAll(() => Effect.succeed({})),
  )
}

export function saveConfig(config: DoomainConfig): DoomainEffect<void> {
  return Effect.gen(function* () {
    const configFile = getConfigFile()
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(configFile), { recursive: true }),
      catch: (cause) => new DoomainError('CONFIG_NOT_FOUND', `Unable to create the config directory: ${String(cause)}`),
    })
    yield* Effect.tryPromise({
      try: () => writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }),
      catch: (cause) => new DoomainError('CONFIG_NOT_FOUND', `Unable to write the config file: ${String(cause)}`),
    })
  })
}

export function updateConfig(updater: (config: DoomainConfig) => DoomainConfig): DoomainEffect<DoomainConfig> {
  return Effect.gen(function* () {
    const next = updater(yield* loadConfig())
    yield* saveConfig(next)
    return next
  })
}

export function clearConfig(): DoomainEffect<boolean, never> {
  return Effect.tryPromise(() => unlink(getConfigFile())).pipe(
    Effect.as(true),
    Effect.catchAll(() => Effect.succeed(false)),
  )
}

export function getConfigPath(): string {
  return getConfigFile()
}

export function maskSecret(value?: string): string | undefined {
  if (!value) return undefined
  if (value.length <= 8) return '********'
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}
