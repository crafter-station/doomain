export interface CommandSchema {
  name: string
  description: string
  examples: string[]
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
      'dmlink link app.example.com --project my-app --json',
      'dmlink link --domain app.example.com --project my-app --json',
      'dmlink link --domain example.com --subdomain app --project my-app --json',
      'dmlink link --provider spaceship --domain example.com --apex --project my-app --dry-run --json',
    ],
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
      {name: 'provider', type: 'string', description: 'DNS provider id. Inferred from the target domain when omitted.'},
      {name: 'domain', type: 'string', description: 'Target domain or base zone, for example app.example.com or example.com.'},
      {name: 'subdomain', type: 'string', description: 'Subdomain to add.'},
      {name: 'apex', type: 'boolean', description: 'Use the root/apex domain.'},
      {name: 'project', type: 'string', description: 'Vercel project id/name.'},
      {name: 'dry-run', type: 'boolean', description: 'Preview changes without writing.'},
      {name: 'force', type: 'boolean', description: 'Overwrite conflicting DNS records.'},
      {name: 'wait', type: 'boolean', description: 'Wait for DNS and Vercel verification.', default: true},
      {name: 'timeout', type: 'integer', description: 'Wait timeout in seconds.', default: 300},
    ],
  },
  {
    name: 'providers connect',
    description: 'Save DNS provider credentials locally after verifying them. Prompts for a provider when omitted.',
    examples: [
      'dmlink providers connect',
      'dmlink providers connect spaceship --credential apiKey=key --credential apiSecret=secret --json',
      'dmlink providers connect namecheap --credential apiUser=user --credential apiKey=key --credential clientIp=127.0.0.1 --json',
      'dmlink providers connect cloudflare --credential apiToken=token --credential accountId=account_id --json',
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
    examples: ['dmlink providers add', 'dmlink providers add namecheap'],
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
      {name: 'credential', type: 'string', description: 'Provider credential as key=value. Can be repeated.'},
      {name: 'no-verify', type: 'boolean', description: 'Save credentials without verifying them first.'},
    ],
  },
  {
    name: 'providers status',
    description: 'Show configured DNS providers and credential health.',
    examples: ['dmlink providers status', 'dmlink providers status --no-verify --json'],
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
      {name: 'no-verify', type: 'boolean', description: 'Skip provider API calls.'},
    ],
  },
  {
    name: 'providers disconnect',
    description: 'Remove saved DNS provider credentials locally.',
    examples: ['dmlink providers disconnect namecheap --json', 'dmlink providers disconnect cloudflare --json'],
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
    ],
  },
  {
    name: 'providers verify',
    description: 'Verify saved DNS provider credentials.',
    examples: ['dmlink providers verify spaceship --json', 'dmlink providers verify namecheap --json'],
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
    ],
  },
  {
    name: 'auth vercel',
    description: 'Save Vercel credentials locally.',
    examples: ['dmlink auth vercel --token token --team-id team_123 --json', 'dmlink auth vercel'],
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
      {name: 'token', type: 'string', description: 'Vercel API token.'},
      {name: 'team-id', type: 'string', description: 'Optional Vercel team id. Interactive mode can fetch and select it.'},
    ],
  },
  {
    name: 'auth logout vercel',
    description: 'Remove saved Vercel credentials locally.',
    examples: ['dmlink auth logout vercel --json'],
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
    ],
  },
]

export function getCommandSchema(name?: string): CommandSchema[] | CommandSchema | undefined {
  if (!name) return commandSchemas
  return commandSchemas.find((schema) => schema.name === name)
}
