import {mkdir, readFile, unlink, writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {dirname, join} from 'node:path'

export function getConfigDir(): string {
  return process.env.DMLINK_CONFIG_DIR || join(homedir(), '.dmlink')
}

export function getConfigFile(): string {
  return process.env.DMLINK_CONFIG_FILE || join(getConfigDir(), 'config.json')
}

export const CONFIG_DIR = getConfigDir()
export const CONFIG_FILE = getConfigFile()

export interface VercelConfig {
  token?: string
  teamId?: string
}

export interface ProviderConfig {
  credentials?: Record<string, string>
  settings?: Record<string, unknown>
}

export interface SpaceshipProviderConfig extends ProviderConfig {
  apiKey?: string
  apiSecret?: string
  domains?: string[]
}

export interface DmlinkConfig {
  vercel?: VercelConfig
  providers?: {
    spaceship?: SpaceshipProviderConfig
    [provider: string]: ProviderConfig | SpaceshipProviderConfig | undefined
  }
  defaults?: {
    provider?: string
    domain?: string
  }
}

export async function loadConfig(): Promise<DmlinkConfig> {
  try {
    const data = await readFile(getConfigFile(), 'utf8')
    return JSON.parse(data) as DmlinkConfig
  } catch {
    return {}
  }
}

export async function saveConfig(config: DmlinkConfig): Promise<void> {
  const configFile = getConfigFile()
  await mkdir(dirname(configFile), {recursive: true})
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, {mode: 0o600})
}

export async function updateConfig(updater: (config: DmlinkConfig) => DmlinkConfig): Promise<DmlinkConfig> {
  const next = updater(await loadConfig())
  await saveConfig(next)
  return next
}

export async function clearConfig(): Promise<boolean> {
  try {
    await unlink(getConfigFile())
    return true
  } catch {
    return false
  }
}

export function getConfigPath(): string {
  return getConfigFile()
}

export function maskSecret(value?: string): string | undefined {
  if (!value) return undefined
  if (value.length <= 8) return '********'
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}
