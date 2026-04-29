import {listProviderStatuses, type ProviderStatus} from './providers/status.js'

export type ProviderConnectionStatus = Pick<ProviderStatus, 'configured' | 'default' | 'displayName' | 'docsUrl' | 'id'>

export interface CommandSchema {
  name: string
  description: string
  examples: string[]
  agentHint?: string
  agentInstructions?: string[]
  agentQuickstart?: {
    doNotPreflight: boolean
    preferredFirstCommand: string
  }
  configuredProviders?: ProviderConnectionStatus[]
  mutates?: boolean
  safeForAgents?: boolean
  flags: Array<{
    name: string
    type: 'boolean' | 'integer' | 'string'
    description: string
    required?: boolean
    default?: unknown
  }>
}

export const commandSchemas: CommandSchema[] = [
  {
    name: 'link',
    description: 'Link a Vercel project to a domain and create DNS records.',
    examples: [
      'doomain link app.example.com --json',
      'doomain link app.example.com --project my-app --json',
      'doomain link --domain app.example.com --project my-app --json',
      'doomain link --domain example.com --subdomain app --project my-app --json',
      'doomain link --provider spaceship --domain example.com --apex --project my-app --dry-run --json',
    ],
    agentHint:
      'For agent use, try `doomain link <domain> --json` first. Do not inspect project files, run provider status, or use --dry-run unless the user explicitly asks for a preview. The command infers project/provider and returns structured recovery errors when inference fails.',
    agentInstructions: [
      'When the user asks to add or link a domain, run `doomain link <domain> --json` first.',
      'Do not run `providers status`, `projects list`, `--help`, or `--dry-run` before the first link attempt unless the user asks for a preview or diagnosis.',
      'Only run follow-up commands when the JSON error includes a recovery action that requires them.',
    ],
    agentQuickstart: {
      doNotPreflight: true,
      preferredFirstCommand: 'doomain link <domain> --json',
    },
    mutates: true,
    safeForAgents: true,
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
      {name: 'provider', type: 'string', description: 'DNS provider id. Inferred from the target domain when omitted.'},
      {name: 'domain', type: 'string', description: 'Target domain or base zone, for example app.example.com or example.com.'},
      {name: 'subdomain', type: 'string', description: 'Subdomain to add.'},
      {name: 'apex', type: 'boolean', description: 'Use the root/apex domain.'},
      {name: 'project', type: 'string', description: 'Vercel project id/name. Optional when project inference succeeds.'},
      {name: 'dry-run', type: 'boolean', description: 'Preview changes without writing. Intended for human previews; agents should not use this unless explicitly asked.'},
      {name: 'force', type: 'boolean', description: 'Overwrite conflicting DNS records.'},
      {name: 'wait', type: 'boolean', description: 'Wait for DNS and Vercel verification.', default: true},
      {name: 'timeout', type: 'integer', description: 'Wait timeout in seconds.', default: 300},
    ],
  },
  {
    name: 'providers connect',
    description: 'Save DNS provider credentials locally after verifying them. Prompts for a provider when omitted.',
    examples: [
      'doomain providers connect',
      'doomain providers connect spaceship --credential apiKey=key --credential apiSecret=secret --json',
      'doomain providers connect namecheap --credential apiUser=user --credential apiKey=key --credential clientIp=127.0.0.1 --json',
      'doomain providers connect cloudflare --credential apiToken=token --credential accountId=account_id --json',
    ],
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
      {name: 'credential', type: 'string', description: 'Provider credential as key=value. Can be repeated.'},
      {name: 'api-key', type: 'string', description: 'Spaceship API key.'},
      {name: 'api-secret', type: 'string', description: 'Spaceship API secret.'},
      {name: 'no-verify', type: 'boolean', description: 'Save credentials without verifying them first.'},
    ],
  },
  {
    name: 'providers add',
    description: 'Alias for providers connect.',
    examples: ['doomain providers add', 'doomain providers add namecheap'],
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
      {name: 'credential', type: 'string', description: 'Provider credential as key=value. Can be repeated.'},
      {name: 'no-verify', type: 'boolean', description: 'Save credentials without verifying them first.'},
    ],
  },
  {
    name: 'providers status',
    description: 'Show configured DNS providers and credential health.',
    examples: ['doomain providers status', 'doomain providers status --no-verify --json'],
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
      {name: 'no-verify', type: 'boolean', description: 'Skip provider API calls.'},
    ],
  },
  {
    name: 'providers disconnect',
    description: 'Remove saved DNS provider credentials locally.',
    examples: ['doomain providers disconnect namecheap --json', 'doomain providers disconnect cloudflare --json'],
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
    ],
  },
  {
    name: 'providers verify',
    description: 'Verify saved DNS provider credentials.',
    examples: ['doomain providers verify spaceship --json', 'doomain providers verify namecheap --json'],
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
    ],
  },
  {
    name: 'auth vercel',
    description: 'Save Vercel credentials locally.',
    examples: ['doomain auth vercel --token token --team-id team_123 --json', 'doomain auth vercel'],
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
      {name: 'token', type: 'string', description: 'Vercel API token.'},
      {name: 'team-id', type: 'string', description: 'Optional Vercel team id. Interactive mode can fetch and select it.'},
    ],
  },
  {
    name: 'auth logout vercel',
    description: 'Remove saved Vercel credentials locally.',
    examples: ['doomain auth logout vercel --json'],
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
    ],
  },
]

export function getCommandSchema(name?: string): CommandSchema[] | CommandSchema | undefined {
  if (!name) return commandSchemas
  return commandSchemas.find((schema) => schema.name === name)
}

async function configuredProviders(): Promise<ProviderConnectionStatus[]> {
  return (await listProviderStatuses({verify: false})).map((provider) => ({
    configured: provider.configured,
    default: provider.default,
    displayName: provider.displayName,
    docsUrl: provider.docsUrl,
    id: provider.id,
  }))
}

function withProviderConnections(schema: CommandSchema, providers: ProviderConnectionStatus[]): CommandSchema {
  if (schema.name !== 'link') return schema
  return {...schema, configuredProviders: providers}
}

export async function getCommandSchemaForAgents(name?: string): Promise<CommandSchema[] | CommandSchema | undefined> {
  const schema = getCommandSchema(name)
  if (!schema) return undefined

  const providers = await configuredProviders()
  if (Array.isArray(schema)) return schema.map((item) => withProviderConnections(item, providers))
  return withProviderConnections(schema, providers)
}
