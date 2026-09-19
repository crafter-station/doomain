import { type ClerkDomainStatus, createClerkPlatformClient, resolveClerkPlatformConfig } from './clerk.js'
import { resolveProviderTarget } from './domain-provider.js'
import { DoomainError } from './errors.js'
import { type DnsOverrideWarning, withProviderRecordOptions } from './link-domain.js'
import { createProvider } from './providers/registry.js'
import type { DnsRecordInput } from './providers/types.js'
import { normalizeDomain } from './validate.js'

export interface AddClerkDomainInput {
  account?: string
  app?: string
  domain?: string
  dryRun?: boolean
  force?: boolean
  provider?: string
  wait?: boolean
  timeoutSeconds?: number
  confirmDnsOverride?: (warning: DnsOverrideWarning) => Promise<boolean>
  progress?: (message: string) => void
}

export interface AddClerkDomainResult {
  account: string
  app: string
  clerk: {
    domainId?: string
    productionInstanceCreated: boolean
    productionInstanceId?: string
    status?: ClerkDomainStatus
    verified: boolean
  }
  dns: {
    propagated: boolean
    skipped: DnsRecordInput[]
    updated: boolean
  }
  domain: string
  dryRun: boolean
  isDefaultAccount: boolean
  provider: string
  records: DnsRecordInput[]
  zoneDomain: string
  nextSteps: string[]
}

function relativeRecordName(host: string, zoneDomain: string): string {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '')
  if (normalized === zoneDomain) return '@'
  if (!normalized.endsWith(`.${zoneDomain}`)) {
    throw new DoomainError(
      'INVALID_INPUT',
      `Clerk returned DNS host ${host}, which is outside the selected zone ${zoneDomain}.`,
    )
  }

  return normalized.slice(0, -(zoneDomain.length + 1))
}

function recordsFromTargets(
  provider: string,
  zoneDomain: string,
  targets: Array<{ host: string; value: string }>,
): DnsRecordInput[] {
  return targets.map((target) =>
    withProviderRecordOptions(provider, {
      name: relativeRecordName(target.host, zoneDomain),
      ttl: 300,
      type: 'CNAME',
      value: target.value.trim().replace(/\.$/, ''),
    }),
  )
}

function productionExistsError(app: string, instanceId: string): DoomainError {
  return new DoomainError(
    'CLERK_PRODUCTION_EXISTS',
    `Clerk application ${app} already has a production instance. Configure domain changes manually in Clerk; Doomain will not modify an existing production domain.`,
    {
      app,
      instanceId,
      recovery:
        'Use the Clerk Dashboard Domains page or `clerk deploy` to inspect and configure the existing production instance.',
      suggestedCommands: [`clerk link --app ${app}`, 'clerk deploy status', 'clerk open domains'],
    },
  )
}

function dnsConflictError(warning: DnsOverrideWarning, productionInstanceId: string): DoomainError {
  return new DoomainError(
    'DNS_TARGET_CONFLICT',
    `${warning.domain} has DNS records that conflict with Clerk's required records. Re-run with --force to overwrite them.`,
    {
      ...warning,
      partialState: { productionInstanceCreated: true, productionInstanceId },
      recovery:
        'The Clerk production instance now exists. Resolve the DNS conflict, then finish setup with `clerk deploy`.',
    },
  )
}

function statusComplete(check: { required?: boolean; status: string } | undefined): boolean {
  return check?.required === false || check?.status === 'complete'
}

async function waitForStatus(
  client: ReturnType<typeof createClerkPlatformClient>,
  app: string,
  domainId: string,
  timeoutSeconds: number,
  progress?: (message: string) => void,
): Promise<ClerkDomainStatus> {
  await client.triggerDomainDnsCheck(app, domainId).catch((error) => {
    const conflict = error instanceof DoomainError && JSON.stringify(error.details).toLowerCase().includes('conflict')
    if (!conflict) throw error
  })

  const deadline = Date.now() + timeoutSeconds * 1000
  let status: ClerkDomainStatus = { status: 'incomplete' }
  let attempt = 1
  while (Date.now() <= deadline) {
    progress?.(`Checking Clerk DNS, SSL, and email DNS status (attempt ${attempt})`)
    status = await client.getDomainStatus(app, domainId)
    if (status.status === 'complete') return status
    attempt += 1
    if (Date.now() > deadline) break
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }

  return status
}

export async function addClerkProductionDomain(input: AddClerkDomainInput): Promise<AddClerkDomainResult> {
  const domain = normalizeDomain(input.domain ?? '')
  const config = await resolveClerkPlatformConfig(input.app)
  const client = createClerkPlatformClient(config)
  input.progress?.('Checking Clerk application')
  const application = await client.fetchApplication(config.appId)
  const production = application.instances.find((instance) => instance.environment_type === 'production')
  if (production) throw productionExistsError(config.appId, production.instance_id)

  const development = application.instances.find((instance) => instance.environment_type === 'development')
  if (!development)
    throw new DoomainError(
      'PROJECT_NOT_FOUND',
      `Clerk application ${config.appId} does not have a development instance to clone.`,
    )

  input.progress?.('Finding the DNS provider and zone')
  const resolved = await resolveProviderTarget({ account: input.account, domain, provider: input.provider })
  const provider = await createProvider(resolved.provider, { account: resolved.account })
  const zone = await provider.getZone(resolved.target.zoneDomain)
  if (!zone)
    throw new DoomainError(
      'PROVIDER_ZONE_NOT_FOUND',
      `${provider.name} does not have a DNS zone for ${resolved.target.zoneDomain}.`,
    )

  const nextSteps = [
    `clerk link --app ${config.appId}`,
    `clerk env pull --app ${config.appId} --instance prod`,
    'clerk deploy',
    'clerk deploy status',
  ]

  if (input.dryRun) {
    return {
      account: resolved.account,
      app: config.appId,
      clerk: { productionInstanceCreated: false, verified: false },
      dns: { propagated: false, skipped: [], updated: false },
      domain,
      dryRun: true,
      isDefaultAccount: resolved.isDefaultAccount,
      nextSteps,
      provider: resolved.provider,
      records: [],
      zoneDomain: resolved.target.zoneDomain,
    }
  }

  input.progress?.('Creating Clerk production instance and primary domain')
  const created = await client.createProductionInstance(config.appId, domain, development.instance_id)
  const clerkDomain = created.active_domain
  if (!clerkDomain) {
    throw new DoomainError(
      'DOMAIN_LINK_FAILED',
      'Clerk created the production instance but did not return its primary domain.',
      {
        productionInstanceId: created.id,
      },
    )
  }

  const records = recordsFromTargets(resolved.provider, resolved.target.zoneDomain, clerkDomain.cname_targets ?? [])
  if (records.length === 0) {
    throw new DoomainError(
      'DOMAIN_LINK_FAILED',
      'Clerk created the production instance but did not return any DNS records.',
      {
        domainId: clerkDomain.id,
        productionInstanceId: created.id,
      },
    )
  }

  input.progress?.(`Checking existing DNS records in ${provider.name}`)
  let forceDns = Boolean(input.force)
  let dnsPlan = await provider.planChanges(zone, records, { force: forceDns })
  if (!forceDns && dnsPlan.conflicts.length > 0) {
    const warning: DnsOverrideWarning = {
      account: resolved.account,
      conflicts: dnsPlan.conflicts,
      desired: records,
      domain,
      provider: resolved.provider,
      providerName: provider.name,
      recordName: records[0]?.name ?? '@',
      zoneDomain: resolved.target.zoneDomain,
    }
    forceDns = (await input.confirmDnsOverride?.(warning)) === true
    if (!forceDns) throw dnsConflictError(warning, created.id)
    dnsPlan = await provider.planChanges(zone, records, { force: true })
  }

  input.progress?.(`Creating Clerk DNS records in ${provider.name}`)
  const dnsResult = await provider.applyChanges(zone, dnsPlan, { force: forceDns })
  const shouldWait = input.wait ?? true
  const status = shouldWait
    ? await waitForStatus(client, config.appId, clerkDomain.id, input.timeoutSeconds ?? 300, input.progress)
    : undefined
  const verified = status?.status === 'complete'
  const propagated = Boolean(status && statusComplete(status.dns) && statusComplete(status.mail))

  return {
    account: resolved.account,
    app: config.appId,
    clerk: {
      domainId: clerkDomain.id,
      productionInstanceCreated: true,
      productionInstanceId: created.id,
      status,
      verified,
    },
    dns: { propagated, skipped: dnsResult.skipped, updated: dnsResult.applied.length > 0 },
    domain,
    dryRun: false,
    isDefaultAccount: resolved.isDefaultAccount,
    nextSteps,
    provider: resolved.provider,
    records,
    zoneDomain: resolved.target.zoneDomain,
  }
}
