import {listProviderStatuses, type ProviderStatus} from './providers/status.js'

export type ProviderConnectionStatus = Pick<
  ProviderStatus,
  'account' | 'configured' | 'default' | 'displayName' | 'docsUrl' | 'id' | 'isDefaultAccount'
>

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
    name: 'dns point',
    description: 'Point a DNS name at an IP address or canonical hostname.',
    examples: [
      'doomain dns point app.example.com --target 203.0.113.10 --json',
      'doomain dns point app.example.com --target origin.example.net --dry-run --json',
      'doomain dns point example.com --target 203.0.113.10 --provider spaceship --account work --force --json',
    ],
    agentHint: 'Use this for non-Vercel infrastructure such as a VPS or load balancer. Run without --dry-run unless the user explicitly requests a preview; conflicts fail safely unless --force is explicit.',
    agentInstructions: [
      'When a user asks to point a domain at a VPS or hostname, run `doomain dns point <domain> --target <ip-or-hostname> --json`.',
      'Pass --force only after the user has approved replacing an existing DNS target.',
    ],
    agentQuickstart: {
      doNotPreflight: true,
      preferredFirstCommand: 'doomain dns point <domain> --target <ip-or-hostname> --json',
    },
    mutates: true,
    safeForAgents: true,
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
      {name: 'domain', type: 'string', description: 'Fully qualified apex or subdomain to point.', required: true},
      {name: 'target', type: 'string', description: 'IPv4, IPv6, or hostname target.', required: true},
      {name: 'type', type: 'string', description: 'A, AAAA, or CNAME. Inferred from the target when omitted.'},
      {name: 'provider', type: 'string', description: 'DNS provider id. Inferred from the target domain when omitted.'},
      {name: 'account', type: 'string', description: 'DNS provider profile/account alias.'},
      {name: 'ttl', type: 'integer', description: 'DNS record TTL in seconds.', default: 300},
      {name: 'dry-run', type: 'boolean', description: 'Preview without writing.'},
      {name: 'force', type: 'boolean', description: 'Overwrite conflicting DNS records.'},
      {name: 'wait', type: 'boolean', description: 'Wait for public DNS propagation. Use --no-wait to skip.', default: true},
      {name: 'timeout', type: 'integer', description: 'DNS propagation wait timeout in seconds.', default: 300},
    ],
  },
  {
    name: 'link',
    description: 'Link a Vercel project to a domain and create DNS records.',
    examples: [
      'doomain link app.example.com --json',
      'doomain link app.example.com --project my-app --json',
      'doomain link --domain app.example.com --project my-app --json',
      'doomain link --domain example.com --subdomain app --project my-app --json',
      'doomain link --project my-app --json',
      'doomain link --provider spaceship --domain example.com --apex --project my-app --dry-run --json',
      'doomain link app.example.com --provider spaceship --account work --project my-app --json',
    ],
    agentHint:
      'For agent use, try `doomain link <domain> --json` first. Do not inspect project files, run provider status, or use --dry-run unless the user explicitly asks for a preview. The command infers project/provider and returns structured recovery errors when inference fails.',
    agentInstructions: [
      'When the user asks to add or link a Vercel domain, run `doomain link <domain> --json` first.',
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
      {name: 'account', type: 'string', description: 'DNS provider profile/account alias. Defaults to the provider default account.'},
      {
        name: 'domain',
        type: 'string',
        description: 'Target domain or base zone, for example app.example.com or example.com. Optional when DOOMAIN_DOMAIN or a default domain is configured.',
      },
      {name: 'subdomain', type: 'string', description: 'Subdomain to add.'},
      {name: 'apex', type: 'boolean', description: 'Use the root/apex domain.'},
      {name: 'project', type: 'string', description: 'Vercel project id/name. Optional when project inference succeeds.'},
      {name: 'dry-run', type: 'boolean', description: 'Preview changes without writing. Intended for human previews; agents should not use this unless explicitly asked.'},
      {
        name: 'force',
        type: 'boolean',
        description: 'Move existing Vercel project domains and overwrite conflicting DNS records. Interactive DNS override confirmation does not move Vercel aliases; pass --force for that.',
      },
      {name: 'wait', type: 'boolean', description: 'Wait for DNS and Vercel verification. Use --no-wait to skip waiting.', default: true},
      {name: 'timeout', type: 'integer', description: 'Wait timeout in seconds.', default: 300},
    ],
  },
  {
    name: 'clerk domains add',
    description: 'Create the first Clerk production instance with its primary domain and configure returned DNS records.',
    examples: [
      'doomain clerk domains add example.com --app app_123 --json',
      'doomain clerk domains add example.com --app app_123 --provider cloudflare --no-wait --json',
      'doomain clerk domains add example.com --app app_123 --dry-run --json',
    ],
    agentHint:
      'Use only for first-time Clerk production setup. The command aborts with CLERK_PRODUCTION_EXISTS when production already exists; domain changes must then be completed manually in Clerk.',
    agentInstructions: [
      'When the user asks to configure a Clerk production domain for the first time, run `doomain clerk domains add <domain> --app <app_id> --json`.',
      'Never use this command to migrate or replace an existing Clerk production domain.',
      'After success, follow the returned nextSteps to pull production keys, finish OAuth setup, and verify provisioning with Clerk CLI.',
    ],
    mutates: true,
    safeForAgents: true,
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
      {name: 'app', type: 'string', description: 'Clerk application id. Defaults to CLERK_APPLICATION_ID or saved Clerk config.'},
      {name: 'provider', type: 'string', description: 'DNS provider id. Inferred from the target domain when omitted.'},
      {name: 'account', type: 'string', description: 'DNS provider profile/account alias. Defaults to the provider default account.'},
      {name: 'dry-run', type: 'boolean', description: 'Check application eligibility and DNS zone without creating production.'},
      {name: 'force', type: 'boolean', description: 'Overwrite DNS records that conflict with Clerk requirements.'},
      {name: 'wait', type: 'boolean', description: 'Wait for Clerk DNS, SSL, and email DNS verification. Use --no-wait to skip waiting.', default: true},
      {name: 'timeout', type: 'integer', description: 'Wait timeout in seconds.', default: 300},
    ],
  },
  {
    name: 'schema',
    description: 'Print machine-readable command schemas for agents.',
    examples: ['doomain schema --json', 'doomain schema link --json'],
    safeForAgents: true,
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
    ],
  },
  {
    name: 'providers list',
    description: 'List supported DNS providers.',
    examples: ['doomain providers list --json'],
    safeForAgents: true,
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
    ],
  },
  {
    name: 'providers connect',
    description: 'Save DNS provider credentials locally after verifying them. Prompts for a provider when omitted.',
    examples: [
      'doomain providers connect',
      'doomain providers connect spaceship --credential apiKey=key --credential apiSecret=secret --json',
      'doomain providers connect spaceship --account work --credential apiKey=key --credential apiSecret=secret --json',
      'doomain providers connect namecheap --credential apiUser=user --credential apiKey=key --credential clientIp=127.0.0.1 --json',
      'doomain providers connect cloudflare --credential apiToken=token --credential accountId=account_id --json',
      'doomain providers connect hostinger --credential apiToken=token --json',
    ],
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
      {name: 'account', type: 'string', description: 'DNS provider profile/account alias. Defaults to the provider default account.'},
      {name: 'credential', type: 'string', description: 'Provider credential as key=value. Can be repeated.'},
      {name: 'api-key', type: 'string', description: 'Spaceship API key.'},
      {name: 'api-secret', type: 'string', description: 'Spaceship API secret.'},
      {name: 'no-verify', type: 'boolean', description: 'Save credentials without verifying them first.'},
    ],
  },
  {
    name: 'providers add',
    description: 'Alias for providers connect.',
    examples: ['doomain providers add', 'doomain providers add namecheap', 'doomain providers add spaceship --account work'],
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
      {name: 'account', type: 'string', description: 'DNS provider profile/account alias. Defaults to the provider default account.'},
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
    examples: [
      'doomain providers disconnect namecheap --json',
      'doomain providers disconnect cloudflare --json',
      'doomain providers disconnect spaceship --account work --json',
      'doomain providers disconnect hostinger --json',
    ],
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
      {name: 'account', type: 'string', description: 'DNS provider profile/account alias. Omit to remove all accounts for the provider.'},
    ],
  },
  {
    name: 'providers verify',
    description: 'Verify saved DNS provider credentials.',
    examples: [
      'doomain providers verify spaceship --json',
      'doomain providers verify spaceship --account work --json',
      'doomain providers verify namecheap --json',
      'doomain providers verify hostinger --json',
    ],
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
      {name: 'account', type: 'string', description: 'DNS provider profile/account alias. Defaults to the provider default account.'},
    ],
  },
  {
    name: 'auth clerk',
    description: 'Save and verify Clerk Platform API credentials locally.',
    examples: ['doomain auth clerk --platform-api-key ak_123 --app app_123 --json', 'doomain auth clerk'],
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
      {name: 'platform-api-key', type: 'string', description: 'Clerk Platform API key (ak_...).'},
      {name: 'app', type: 'string', description: 'Default Clerk application id.'},
    ],
  },
  {
    name: 'auth logout clerk',
    description: 'Remove saved Clerk credentials locally.',
    examples: ['doomain auth logout clerk --json'],
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
  {
    name: 'domains find',
    description: 'Find the configured DNS provider and account for a domain.',
    examples: [
      'doomain domains find hacktheandes.com --json',
      'doomain domains find api.example.com --json',
      'doomain domains find --domain example.com --provider spaceship --account work --json',
    ],
    agentHint:
      'Use this command when you need to identify who manages DNS for a domain. It checks all configured provider accounts, tolerates individual provider failures, and selects the longest matching DNS zone. Inspect complete and warnings before treating the result as exhaustive.',
    safeForAgents: true,
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
      {name: 'domain', type: 'string', description: 'Domain to find. May also be passed as the positional argument.'},
      {name: 'provider', type: 'string', description: 'Limit discovery to one DNS provider id.'},
      {name: 'account', type: 'string', description: 'Limit discovery to one DNS provider profile/account alias.'},
    ],
  },
  {
    name: 'domains list',
    description: 'List DNS zones and records for a provider.',
    examples: ['doomain domains list --json', 'doomain domains list --provider cloudflare --domain example.com --json'],
    safeForAgents: true,
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
      {name: 'provider', type: 'string', description: 'DNS provider id. Defaults to DOOMAIN_PROVIDER, configured default provider, then spaceship.'},
      {name: 'account', type: 'string', description: 'DNS provider profile/account alias. Omit to list all configured accounts for the provider.'},
      {name: 'domain', type: 'string', description: 'Limit output to one DNS zone.'},
    ],
  },
  {
    name: 'projects list',
    description: 'List Vercel projects.',
    examples: ['doomain projects list --json', 'doomain projects list --search my-app --json'],
    safeForAgents: true,
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
      {name: 'search', type: 'string', description: 'Filter projects by search term.'},
    ],
  },
  {
    name: 'verify',
    description: 'Ask Vercel to verify a project domain.',
    examples: ['doomain verify --domain app.example.com --project my-app --json', 'doomain verify --domain example.com --apex --project my-app --json'],
    mutates: true,
    safeForAgents: true,
    flags: [
      {name: 'json', type: 'boolean', description: 'Output a single JSON object and never prompt.'},
      {name: 'domain', type: 'string', description: 'Target domain or base zone, for example app.example.com or example.com.', required: true},
      {name: 'subdomain', type: 'string', description: 'Subdomain to verify.'},
      {name: 'apex', type: 'boolean', description: 'Use the root/apex domain.'},
      {name: 'project', type: 'string', description: 'Vercel project id/name. Optional when local .vercel/project.json is available.'},
    ],
  },
]

export function getCommandSchema(name?: string): CommandSchema[] | CommandSchema | undefined {
  if (!name) return commandSchemas
  return commandSchemas.find((schema) => schema.name === name)
}

async function configuredProviders(): Promise<ProviderConnectionStatus[]> {
  return (await listProviderStatuses({verify: false})).map((provider) => ({
    account: provider.account,
    configured: provider.configured,
    default: provider.default,
    displayName: provider.displayName,
    docsUrl: provider.docsUrl,
    id: provider.id,
    isDefaultAccount: provider.isDefaultAccount,
  }))
}

function withProviderConnections(schema: CommandSchema, providers: ProviderConnectionStatus[]): CommandSchema {
  if (schema.name !== 'link' && schema.name !== 'clerk domains add' && schema.name !== 'dns point') return schema
  return {...schema, configuredProviders: providers}
}

export async function getCommandSchemaForAgents(name?: string): Promise<CommandSchema[] | CommandSchema | undefined> {
  const schema = getCommandSchema(name)
  if (!schema) return undefined

  const providers = await configuredProviders()
  if (Array.isArray(schema)) return schema.map((item) => withProviderConnections(item, providers))
  return withProviderConnections(schema, providers)
}
