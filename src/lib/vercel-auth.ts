import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Effect } from 'effect'

import type { DoomainEffect } from './effect.js'

export type GlobalVercelTokenSource = 'environment' | 'vercel-cli'

export interface GlobalVercelToken {
  authFile?: string
  label: string
  source: GlobalVercelTokenSource
  token: string
}

interface VercelCliAuthFile {
  token?: unknown
}

function xdgDataHome(env: NodeJS.ProcessEnv): string {
  if (env.XDG_DATA_HOME) return env.XDG_DATA_HOME
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  if (process.platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'xdg.data')
  return join(homedir(), '.local', 'share')
}

function xdgDataDirs(appName: string, env: NodeJS.ProcessEnv): string[] {
  const dirs = [join(xdgDataHome(env), appName)]
  if (env.XDG_DATA_DIRS) dirs.push(...env.XDG_DATA_DIRS.split(delimiter).map((dir) => join(dir, appName)))
  return dirs
}

export function getVercelCliAuthFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    ...xdgDataDirs('com.vercel.cli', env),
    join(homedir(), '.now'),
    ...xdgDataDirs('now', env),
    join(homedir(), '.vercel'),
  ].map((dir) => join(dir, 'auth.json'))
}

function readVercelCliToken(authFile: string): DoomainEffect<string | undefined, never> {
  return Effect.tryPromise(() => readFile(authFile, 'utf8')).pipe(
    Effect.flatMap((contents) => Effect.try(() => JSON.parse(contents) as VercelCliAuthFile)),
    Effect.map((data) => (typeof data.token === 'string' && data.token.trim() ? data.token.trim() : undefined)),
    Effect.catchAll(() => Effect.succeed(undefined)),
  )
}

export function listGlobalVercelTokens(
  opts: { authFile?: string; authFiles?: string[]; env?: NodeJS.ProcessEnv } = {},
): DoomainEffect<GlobalVercelToken[], never> {
  return Effect.gen(function* () {
    const env = opts.env ?? process.env
    const tokens: GlobalVercelToken[] = []
    const envToken = env.VERCEL_TOKEN?.trim()

    if (envToken) {
      tokens.push({ label: 'VERCEL_TOKEN', source: 'environment', token: envToken })
    }

    const authFiles = opts.authFile ? [opts.authFile] : (opts.authFiles ?? getVercelCliAuthFiles(env))
    for (const authFile of authFiles) {
      if (!existsSync(authFile)) continue
      const cliToken = yield* readVercelCliToken(authFile)
      if (cliToken && !tokens.some((item) => item.token === cliToken)) {
        tokens.push({ authFile, label: 'Vercel CLI', source: 'vercel-cli', token: cliToken })
      }
    }

    return tokens
  })
}
