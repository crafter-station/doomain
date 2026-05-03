import {resolve4, resolveCname, resolveTxt} from 'node:dns/promises'
import {existsSync, readFileSync} from 'node:fs'
import {dirname, join, parse} from 'node:path'

import {loadConfig} from './config.js'
import {DoomainError} from './errors.js'
import {detectLocalVercelProject} from './local-vercel.js'
import {
  DEFAULT_PROVIDER_ACCOUNT,
  isDefaultProviderAccount,
  listConfiguredProviderAccounts,
  normalizeProviderAccount,
  type ProviderAccountRef,
} from './providers/core/config.js'
import {createProvider, getProviderDefinition, listProviderDefinitions} from './providers/registry.js'
import {listProviderStatuses} from './providers/status.js'
import type {DnsConflict, DnsProvider, DnsProviderDefinition, DnsRecordInput, DnsZone} from './providers/types.js'
import {normalizeDomain, normalizeSubdomain} from './validate.js'
import {createVercelClient, resolveVercelConfig, VERCEL_APEX_A_RECORD, VERCEL_CNAME_RECORD, type VercelProject} from './vercel.js'

export interface LinkDomainInput {
  provider?: string
  account?: string
  domain?: string
  subdomain?: string
  apex?: boolean
  project?: string
  dryRun?: boolean
  force?: boolean
  wait?: boolean
  timeoutSeconds?: number
  progress?: LinkDomainProgressCallback
  confirmDnsOverride?: (warning: DnsOverrideWarning) => Promise<boolean>
}

export type LinkDomainProjectSource = 'config' | 'env' | 'flag' | 'packageJson' | 'vercelProjectFile'

export type LinkDomainProgressStage =
  | 'dns:apply'
  | 'dns:inspect'
  | 'dns:override-confirm'
  | 'dns:plan'
  | 'dns:resolve-zone'
  | 'dns:wait'
  | 'vercel:add-domain'
  | 'vercel:get-domain'
  | 'vercel:get-target'
  | 'vercel:verify'

export interface LinkDomainProgress {
  message: string
  stage: LinkDomainProgressStage
}

export type LinkDomainProgressCallback = (progress: LinkDomainProgress) => void

export interface DnsOverrideWarning {
  account: string
  conflicts: DnsConflict[]
  desired: DnsRecordInput[]
  domain: string
  provider: string
  providerName: string
  recordName: string
  zoneDomain: string
}

export interface LinkDomainPlan {
  provider: string
  providerInferred: boolean
  account: string
  accountInferred: boolean
  isDefaultAccount: boolean
  project: string
  projectSource: LinkDomainProjectSource
  recordName: string
  zoneDomain: string
  domain: string
  isApex: boolean
  records: DnsRecordInput[]
  actions: string[]
  localProjectDetected: boolean
}

export interface LinkDomainResult extends LinkDomainPlan {
  dryRun: boolean
  dns: {
    updated: boolean
    propagated: boolean
    skipped: DnsRecordInput[]
  }
  vercel: {
    added: boolean
    alreadyAdded: boolean
    verified: boolean
  }
}

function cleanDnsValue(value: string): string {
  return value.toLowerCase().replace(/\.$/, '')
}

function recordFqdn(record: DnsRecordInput, zoneDomain: string): string {
  return record.name === '@' ? zoneDomain : `${record.name}.${zoneDomain}`
}

async function resolveConfiguredDomain(domain?: string): Promise<string> {
  const config = await loadConfig()
  const resolved = domain ?? process.env.DOOMAIN_DOMAIN ?? config.defaults?.domain
  if (!resolved) throw new DoomainError('MISSING_ARGUMENT', 'Domain is required. Use --domain or set a default domain.')
  return resolved
}

function findPackageProjectName(start = process.cwd()): string | undefined {
  let current = start
  const root = parse(start).root

  while (true) {
    const packagePath = join(current, 'package.json')
    if (existsSync(packagePath)) {
      try {
        const data = JSON.parse(readFileSync(packagePath, 'utf8')) as {name?: unknown}
        if (typeof data.name === 'string' && data.name.trim()) return data.name.trim()
      } catch {
        return undefined
      }
    }

    if (current === root) return undefined
    current = dirname(current)
  }
}

function projectSuggestionScore(projectName: string, project: VercelProject): number {
  const target = projectName.toLowerCase()
  const name = project.name.toLowerCase()
  const id = project.id.toLowerCase()

  if (name === target || id === target) return 0
  if (name.startsWith(target)) return 1
  if (name.includes(target)) return 2
  if (target.includes(name)) return 3

  const targetParts = target.split(/[^a-z0-9]+/).filter(Boolean)
  const matchingParts = targetParts.filter((part) => name.includes(part)).length
  return matchingParts > 0 ? 4 + (targetParts.length - matchingParts) : 99
}

function projectSuggestions(projectName: string, projects: VercelProject[]): Array<Pick<VercelProject, 'id' | 'name'>> {
  const seen = new Set<string>()
  return projects
    .filter((project) => {
      if (seen.has(project.id)) return false
      seen.add(project.id)
      return true
    })
    .map((project) => ({project, score: projectSuggestionScore(projectName, project)}))
    .filter(({score}) => score < 99)
    .sort((a, b) => a.score - b.score || a.project.name.localeCompare(b.project.name))
    .slice(0, 5)
    .map(({project}) => ({id: project.id, name: project.name}))
}

async function resolvePackageProject(projectName: string): Promise<string> {
  const vercel = createVercelClient(await resolveVercelConfig())
  const projects = await vercel.listProjects(projectName)
  const match = projects.find((project) => project.name === projectName || project.id === projectName)
  if (match) return match.name

  const allProjects = await vercel.listProjects().catch(() => [])
  const suggestions = projectSuggestions(projectName, [...projects, ...allProjects])

  throw new DoomainError('VERCEL_PROJECT_NOT_LINKED', `No Vercel project named ${projectName} was found. Pass --project to choose a project.`, {
    project: projectName,
    projectSource: 'packageJson',
    suggestions,
  })
}

async function resolveProject(project?: string): Promise<{project: string; projectSource: LinkDomainProjectSource; localProjectDetected: boolean}> {
  if (project) return {project, projectSource: 'flag', localProjectDetected: false}

  const config = await loadConfig()
  const envProject = process.env.DOOMAIN_PROJECT
  if (envProject) return {project: envProject, projectSource: 'env', localProjectDetected: false}
  if (config.defaults?.project) return {project: config.defaults.project, projectSource: 'config', localProjectDetected: false}

  const localProject = detectLocalVercelProject()
  if (localProject) return {project: localProject.projectId, projectSource: 'vercelProjectFile', localProjectDetected: true}

  const packageProject = findPackageProjectName()
  if (packageProject) {
    return {
      project: await resolvePackageProject(packageProject),
      projectSource: 'packageJson',
      localProjectDetected: false,
    }
  }

  throw new DoomainError(
    'VERCEL_PROJECT_NOT_LINKED',
    'No Vercel project could be inferred. Run inside a project with package.json/.vercel/project.json or pass --project.',
  )
}

async function resolveZone(provider: DnsProvider, zoneDomain: string): Promise<DnsZone> {
  const zone = await provider.getZone(zoneDomain)
  if (!zone) {
    throw new DoomainError('PROVIDER_ZONE_NOT_FOUND', `${provider.name} does not have a DNS zone for ${zoneDomain}.`)
  }

  return zone
}

interface RequestedDomain {
  forceExactZone: boolean
  fullDomain: string
}

interface ProviderZoneCandidate {
  account: string
  isDefaultAccount: boolean
  provider: string
  providerName: string
  zone: DnsZone
}

interface ProviderZoneSearchResult {
  account: string
  displayName: string
  error?: string
  id: string
  isDefaultAccount: boolean
  zones: string[]
}

async function providerConnectionDetails() {
  return (await listProviderStatuses({verify: false})).map((provider) => ({
    configured: provider.configured,
    account: provider.account,
    default: provider.default,
    displayName: provider.displayName,
    docsUrl: provider.docsUrl,
    id: provider.id,
    isDefaultAccount: provider.isDefaultAccount,
  }))
}

interface ResolvedTarget {
  provider: string
  providerInferred: boolean
  account: string
  accountInferred: boolean
  isDefaultAccount: boolean
  target: {
    fullDomain: string
    isApex: boolean
    recordName: string
    zoneDomain: string
  }
}

function resolveRequestedDomain(opts: {apex?: boolean; domain: string; subdomain?: string}): RequestedDomain {
  if (opts.apex && opts.subdomain) {
    throw new DoomainError('INVALID_INPUT', 'Use either --apex or --subdomain, not both.')
  }

  const domain = normalizeDomain(opts.domain)
  if (opts.apex) return {forceExactZone: true, fullDomain: domain}
  if (!opts.subdomain) return {forceExactZone: false, fullDomain: domain}

  return {forceExactZone: false, fullDomain: `${normalizeSubdomain(opts.subdomain)}.${domain}`}
}

function zoneMatchesDomain(fullDomain: string, zoneDomain: string, forceExactZone: boolean): boolean {
  if (fullDomain === zoneDomain) return true
  if (forceExactZone) return false
  return fullDomain.endsWith(`.${zoneDomain}`)
}

function targetFromZone(fullDomain: string, zoneDomain: string): ResolvedTarget['target'] {
  if (fullDomain === zoneDomain) {
    return {fullDomain, isApex: true, recordName: '@', zoneDomain}
  }

  return {
    fullDomain,
    isApex: false,
    recordName: fullDomain.slice(0, -(zoneDomain.length + 1)),
    zoneDomain,
  }
}

function candidateDetails(candidates: ProviderZoneCandidate[]) {
  return candidates.map((candidate) => ({
    account: candidate.account,
    isDefaultAccount: candidate.isDefaultAccount,
    provider: candidate.provider,
    providerName: candidate.providerName,
    zoneDomain: candidate.zone.name,
  }))
}

function defaultAccountRef(providerId: string): ProviderAccountRef {
  return {account: DEFAULT_PROVIDER_ACCOUNT, isDefaultAccount: true, providerId}
}

function explicitAccountRef(providerId: string, account: string): ProviderAccountRef {
  const normalized = normalizeProviderAccount(account)
  return {account: normalized, isDefaultAccount: isDefaultProviderAccount(normalized), providerId}
}

async function loadProviderZones(definition: DnsProviderDefinition, account: ProviderAccountRef): Promise<{
  candidates: ProviderZoneCandidate[]
  search: ProviderZoneSearchResult
}> {
  const provider = await createProvider(definition.id, {account: account.account})
  const zones = await provider.listZones()
  return {
    candidates: zones.map((zone) => ({
      account: account.account,
      isDefaultAccount: account.isDefaultAccount,
      provider: definition.id,
      providerName: definition.displayName,
      zone,
    })),
    search: {
      account: account.account,
      displayName: definition.displayName,
      id: definition.id,
      isDefaultAccount: account.isDefaultAccount,
      zones: zones.map((zone) => zone.name),
    },
  }
}

async function loadConfiguredProviderZones(providerId?: string, accountInput?: string): Promise<{
  candidates: ProviderZoneCandidate[]
  accountInferred: boolean
  providerInferred: boolean
  searched: ProviderZoneSearchResult[]
}> {
  const config = await loadConfig()
  const account = accountInput ? normalizeProviderAccount(accountInput) : undefined

  if (providerId) {
    const definition = getProviderDefinition(providerId)
    const accounts = account ? [explicitAccountRef(definition.id, account)] : listConfiguredProviderAccounts(config, definition)
    const selectedAccounts = accounts.length > 0 ? accounts : [defaultAccountRef(definition.id)]
    const results = await Promise.all(selectedAccounts.map((ref) => loadProviderZones(definition, ref)))
    return {
      accountInferred: account === undefined,
      candidates: results.flatMap((result) => result.candidates),
      providerInferred: false,
      searched: results.map((result) => result.search),
    }
  }

  const providerAccounts = listProviderDefinitions().flatMap((definition) =>
    listConfiguredProviderAccounts(config, definition)
      .filter((ref) => !account || ref.account === account)
      .map((ref) => ({definition, ref})),
  )

  if (providerAccounts.length === 0) {
    const message = account
      ? `No DNS provider account named ${account} is configured. Run \`doomain providers connect <provider> --account ${account}\` first.`
      : 'No DNS provider is configured. Run `doomain providers connect` first.'
    throw new DoomainError('CONFIG_NOT_FOUND', message, {
      account,
      configuredProviders: await providerConnectionDetails(),
      recovery: 'Connect the DNS provider that owns this domain, then retry `doomain link <domain> --json`.',
      suggestedCommands: account
        ? [`doomain providers connect <provider> --account ${account}`, 'doomain link <domain> --json']
        : ['doomain providers connect', 'doomain link <domain> --json'],
    })
  }

  const results = await Promise.all(
    providerAccounts.map(async ({definition, ref}) => {
      try {
        return await loadProviderZones(definition, ref)
      } catch (error) {
        return {
          candidates: [],
          search: {
            account: ref.account,
            displayName: definition.displayName,
            error: error instanceof Error ? error.message : String(error),
            id: definition.id,
            isDefaultAccount: ref.isDefaultAccount,
            zones: [],
          },
        }
      }
    }),
  )

  return {
    accountInferred: account === undefined,
    candidates: results.flatMap((result) => result.candidates),
    providerInferred: true,
    searched: results.map((result) => result.search),
  }
}

async function resolveProviderTarget(input: LinkDomainInput): Promise<ResolvedTarget> {
  const requested = resolveRequestedDomain({
    apex: input.apex,
    domain: await resolveConfiguredDomain(input.domain),
    subdomain: input.subdomain,
  })
  const zones = await loadConfiguredProviderZones(input.provider, input.account)
  const matches = zones.candidates
    .filter((candidate) => zoneMatchesDomain(requested.fullDomain, candidate.zone.name, requested.forceExactZone))
    .sort((a, b) => b.zone.name.length - a.zone.name.length)

  if (matches.length === 0) {
    const account = input.account ? normalizeProviderAccount(input.account) : undefined
    const providerMessage = input.provider
      ? `${getProviderDefinition(input.provider).displayName}${account ? ` account ${account}` : ''} does not have a matching DNS zone for ${requested.fullDomain}.`
      : `No configured DNS provider has a matching DNS zone for ${requested.fullDomain}.`
    throw new DoomainError('PROVIDER_ZONE_NOT_FOUND', providerMessage, {
      account,
      configuredProviders: await providerConnectionDetails(),
      domain: requested.fullDomain,
      recovery:
        'Retry with --provider <id> --account <alias> only if another configured provider account owns this zone. Otherwise connect the DNS provider account that owns this domain.',
      searchedZones: zones.searched,
      suggestedCommands: [`doomain link ${requested.fullDomain} --provider <id> --account <alias> --json`, 'doomain providers connect'],
    })
  }

  const bestLength = matches[0].zone.name.length
  const bestMatches = matches.filter((candidate) => candidate.zone.name.length === bestLength)
  const uniqueBestMatches = bestMatches.filter(
    (candidate, index, candidates) =>
      candidates.findIndex(
        (item) => item.provider === candidate.provider && item.account === candidate.account && item.zone.name === candidate.zone.name,
      ) === index,
  )

  if (uniqueBestMatches.length > 1) {
    throw new DoomainError(
      'PROVIDER_ZONE_AMBIGUOUS',
      `Multiple DNS provider accounts have a matching DNS zone for ${requested.fullDomain}. Pass --provider and --account to choose one.`,
      {candidates: candidateDetails(uniqueBestMatches), domain: requested.fullDomain},
    )
  }

  const selected = uniqueBestMatches[0]
  return {
    account: selected.account,
    accountInferred: zones.accountInferred,
    isDefaultAccount: selected.isDefaultAccount,
    provider: selected.provider,
    providerInferred: zones.providerInferred,
    target: targetFromZone(requested.fullDomain, selected.zone.name),
  }
}

function withProviderRecordOptions(provider: string, record: DnsRecordInput): DnsRecordInput {
  if (provider !== 'cloudflare' || !['A', 'AAAA', 'CNAME'].includes(record.type)) return record
  return {...record, proxied: false}
}

function planBaseRecord(opts: {isApex: boolean; provider: string; recordName: string; cname?: string}): DnsRecordInput {
  const record = opts.isApex
    ? ({type: 'A', name: '@', value: VERCEL_APEX_A_RECORD, ttl: 3600} as const)
    : ({type: 'CNAME', name: opts.recordName, value: opts.cname ?? VERCEL_CNAME_RECORD, ttl: 3600} as const)

  return withProviderRecordOptions(opts.provider, record)
}

function planVerificationRecords(provider: string, raw: unknown, zoneDomain: string): DnsRecordInput[] {
  return verificationRecords(raw, zoneDomain).map((record) => withProviderRecordOptions(provider, record))
}

interface VercelVerificationRecord {
  domain?: string
  name?: string
  type?: string
  value?: string
}

function cleanVerificationName(name: string, zoneDomain: string): string {
  const cleaned = name.trim().toLowerCase().replace(/\.$/, '')
  const zone = zoneDomain.toLowerCase().replace(/\.$/, '')
  if (cleaned === zone) return '@'
  if (cleaned.endsWith(`.${zone}`)) return cleaned.slice(0, -(zone.length + 1)) || '@'
  return cleaned
}

function collectVerificationRecords(raw: unknown, seen = new Set<unknown>()): VercelVerificationRecord[] {
  if (!raw || typeof raw !== 'object' || seen.has(raw)) return []
  seen.add(raw)

  if (Array.isArray(raw)) return raw.flatMap((item) => collectVerificationRecords(item, seen))

  const object = raw as Record<string, unknown>
  const verification = object.verification
  const records = Array.isArray(verification) ? (verification as VercelVerificationRecord[]) : []
  const nested = Object.entries(object).flatMap(([key, value]) => (key === 'verification' ? [] : collectVerificationRecords(value, seen)))
  return [...records, ...nested]
}

function uniqueRecords(records: DnsRecordInput[]): DnsRecordInput[] {
  const seen = new Set<string>()
  const unique: DnsRecordInput[] = []

  for (const record of records) {
    const key = `${record.type}:${record.name}:${record.value}:${record.proxied ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(record)
  }

  return unique
}

function recordKey(record: DnsRecordInput): string {
  return `${record.type}:${record.name}:${record.value}:${record.proxied ?? ''}`
}

function mergeRecords(records: DnsRecordInput[], nextRecords: DnsRecordInput[]): {records: DnsRecordInput[]; added: DnsRecordInput[]} {
  const existing = new Set(records.map(recordKey))
  const added = nextRecords.filter((record) => !existing.has(recordKey(record)))
  return {records: [...records, ...added], added}
}

function errorDetails(error: unknown): unknown {
  return error instanceof DoomainError ? error.details : undefined
}

function isDomainConfigReady(config: Record<string, unknown> | undefined): boolean {
  return config?.misconfigured !== true
}

export function verificationRecords(raw: unknown, zoneDomain: string): DnsRecordInput[] {
  const verification = collectVerificationRecords(raw)

  return verification.flatMap((record) => {
    if (record.type !== 'TXT' || !record.value) return []
    const name = record.domain ?? record.name
    if (!name) return []
    return [{type: 'TXT' as const, name: cleanVerificationName(name, zoneDomain), value: record.value, ttl: 3600}]
  })
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

async function isRecordPropagated(record: DnsRecordInput, zoneDomain: string): Promise<boolean> {
  const fqdn = recordFqdn(record, zoneDomain)

  try {
    if (record.type === 'A') {
      const values = await resolve4(fqdn)
      return values.includes(record.value)
    }

    if (record.type === 'CNAME') {
      const values = await resolveCname(fqdn)
      return values.map(cleanDnsValue).includes(cleanDnsValue(record.value))
    }

    if (record.type === 'TXT') {
      const values = (await resolveTxt(fqdn)).map((chunks) => chunks.join(''))
      return values.includes(record.value)
    }
  } catch {
    return false
  }

  return false
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

async function areRecordsPropagated(records: DnsRecordInput[], zoneDomain: string): Promise<boolean> {
  const results = await Promise.all(records.map((record) => isRecordPropagated(record, zoneDomain)))
  return results.every(Boolean)
}

async function waitForVercelDomainReady(
  opts: {
    domain: string
    force?: boolean
    input: LinkDomainInput
    project: string
    provider: DnsProvider
    providerId: string
    records: DnsRecordInput[]
    zone: DnsZone
    zoneDomain: string
  },
): Promise<{propagated: boolean; verified: boolean}> {
  const vercel = createVercelClient(await resolveVercelConfig())
  const timeoutSeconds = opts.input.timeoutSeconds ?? 300
  const startedAt = Date.now()
  const deadline = Date.now() + timeoutSeconds * 1000
  let lastError: unknown
  let lastConfig: Record<string, unknown> | undefined
  let propagated = false
  let attempt = 1
  let records = opts.records

  async function applyVerificationRecords(raw: unknown): Promise<void> {
    const nextRecords = planVerificationRecords(opts.providerId, raw, opts.zoneDomain)
    const merged = mergeRecords(records, nextRecords)
    if (merged.added.length === 0) return

    reportProgress(opts.input, 'dns:plan', `Found ${merged.added.length} new Vercel ownership record${merged.added.length === 1 ? '' : 's'}`)
    const dnsPlan = await opts.provider.planChanges(opts.zone, merged.added, {force: opts.force})
    reportProgress(opts.input, 'dns:apply', `Updating ownership records in ${opts.provider.name}`)
    await opts.provider.applyChanges(opts.zone, dnsPlan, {force: opts.force})
    records = merged.records
  }

  async function isVercelReady(raw: Record<string, unknown>): Promise<boolean> {
    await applyVerificationRecords(raw)
    if (raw.verified !== true) return false

    lastConfig = await vercel.getDomainConfig(opts.domain)
    return isDomainConfigReady(lastConfig)
  }

  while (Date.now() <= deadline) {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000)
    reportProgress(opts.input, 'vercel:verify', `Verifying domain in Vercel (attempt ${attempt}, ${elapsedSeconds}s elapsed)`)

    try {
      const current = await vercel.getProjectDomain(opts.project, opts.domain)
      if (await isVercelReady(current)) return {propagated: true, verified: true}

      const result = await vercel.verifyProjectDomain(opts.project, opts.domain)
      if (await isVercelReady(result)) return {propagated: true, verified: true}
    } catch (error) {
      // Vercel returns an error while DNS is still propagating.
      lastError = error
      await applyVerificationRecords(errorDetails(error))
    }

    propagated = await areRecordsPropagated(records, opts.zoneDomain)
    reportProgress(
      opts.input,
      'dns:wait',
      propagated
        ? 'DNS is visible publicly; Vercel verification is still pending'
        : 'DNS records were saved; public DNS is still catching up',
    )
    attempt += 1
    if (Date.now() > deadline) break
    await wait(5000)
  }

  if (lastError) {
    throw new DoomainError(
      'DOMAIN_VERIFY_FAILED',
      `Vercel did not verify ${opts.domain} within ${timeoutSeconds} seconds. Last Vercel response: ${errorMessage(lastError)}`,
      {domainConfig: lastConfig, error: errorDetails(lastError)},
    )
  }

  if (lastConfig?.misconfigured === true) {
    throw new DoomainError(
      'DOMAIN_VERIFY_FAILED',
      `Vercel verified ${opts.domain}, but its DNS configuration is still invalid after ${timeoutSeconds} seconds.`,
      {domainConfig: lastConfig},
    )
  }

  return {propagated, verified: false}
}

function reportProgress(input: LinkDomainInput, stage: LinkDomainProgressStage, message: string): void {
  input.progress?.({message, stage})
}

function dnsTargetConflictError(warning: DnsOverrideWarning): DoomainError {
  return new DoomainError(
    'DNS_TARGET_CONFLICT',
    `${warning.domain} already has DNS records that point somewhere else. Re-run with --force to overwrite them.`,
    {
      account: warning.account,
      conflicts: warning.conflicts,
      desired: warning.desired,
      domain: warning.domain,
      provider: warning.provider,
      providerName: warning.providerName,
      recovery: 'Confirm the DNS override in interactive mode, or re-run with --force to overwrite conflicting DNS records.',
      recordName: warning.recordName,
      suggestedCommands: [`doomain link ${warning.domain} --project <project> --force --json`],
      zoneDomain: warning.zoneDomain,
    },
  )
}

async function resolveDnsForce(input: LinkDomainInput, opts: {baseRecord: DnsRecordInput; plan: LinkDomainPlan; provider: DnsProvider; zone: DnsZone}): Promise<boolean> {
  reportProgress(input, 'dns:inspect', `Checking existing DNS records in ${opts.provider.name}`)
  const dnsPlan = await opts.provider.planChanges(opts.zone, [opts.baseRecord], {force: input.force})

  if (input.force || dnsPlan.conflicts.length === 0) return Boolean(input.force)

  const warning: DnsOverrideWarning = {
    account: opts.plan.account,
    conflicts: dnsPlan.conflicts,
    desired: [opts.baseRecord],
    domain: opts.plan.domain,
    provider: opts.plan.provider,
    providerName: opts.provider.name,
    recordName: opts.plan.recordName,
    zoneDomain: opts.plan.zoneDomain,
  }

  reportProgress(input, 'dns:override-confirm', `Existing DNS records point ${opts.plan.domain} somewhere else`)
  const confirmed = await input.confirmDnsOverride?.(warning)
  if (!confirmed) throw dnsTargetConflictError(warning)

  return true
}

export async function createLinkPlan(input: LinkDomainInput): Promise<LinkDomainPlan> {
  const project = await resolveProject(input.project)
  const resolved = await resolveProviderTarget(input)
  const {account, accountInferred, isDefaultAccount, provider, providerInferred, target} = resolved
  const record = planBaseRecord({isApex: target.isApex, provider, recordName: target.recordName})

  return {
    account,
    accountInferred,
    isDefaultAccount,
    provider,
    providerInferred,
    project: project.project,
    projectSource: project.projectSource,
    recordName: target.recordName,
    zoneDomain: target.zoneDomain,
    domain: target.fullDomain,
    isApex: target.isApex,
    records: [record],
    localProjectDetected: project.localProjectDetected,
    actions: ['vercel:addProjectDomain', 'dns:upsertRecord', 'dns:waitPropagation', 'vercel:verifyProjectDomain'],
  }
}

export async function linkDomain(input: LinkDomainInput): Promise<LinkDomainResult> {
  const plan = await createLinkPlan(input)

  if (input.dryRun) {
    return {
      ...plan,
      dryRun: true,
      dns: {updated: false, propagated: false, skipped: []},
      vercel: {added: false, alreadyAdded: false, verified: false},
    }
  }

  const vercel = createVercelClient(await resolveVercelConfig())
  const provider = await createProvider(plan.provider, {account: plan.account})
  reportProgress(input, 'dns:resolve-zone', `Finding ${provider.name} DNS zone`)
  const zone = await resolveZone(provider, plan.zoneDomain)
  reportProgress(input, 'vercel:get-target', 'Reading Vercel DNS target')
  const cname = plan.isApex ? undefined : await vercel.getRecommendedCname(plan.domain)
  const baseRecord = planBaseRecord({isApex: plan.isApex, provider: plan.provider, recordName: plan.recordName, cname})
  const forceDns = await resolveDnsForce(input, {baseRecord, plan, provider, zone})
  reportProgress(input, 'vercel:add-domain', 'Adding domain to Vercel')
  const addResult = await vercel.addDomainToProject(plan.project, plan.domain, {force: input.force})
  reportProgress(input, 'vercel:get-domain', 'Reading Vercel verification records')
  const projectDomain = await vercel.getProjectDomain(plan.project, plan.domain)
  const verificationDnsRecords = uniqueRecords([
    ...planVerificationRecords(plan.provider, addResult.raw, plan.zoneDomain),
    ...planVerificationRecords(plan.provider, projectDomain, plan.zoneDomain),
  ])
  const records = [baseRecord, ...verificationDnsRecords]
  reportProgress(input, 'dns:plan', `Reading ${provider.name} DNS records`)
  const dnsPlan = await provider.planChanges(zone, records, {force: forceDns})
  reportProgress(input, 'dns:apply', `Updating DNS records in ${provider.name}`)
  const dnsResult = await provider.applyChanges(zone, dnsPlan, {force: forceDns})

  const shouldWait = input.wait ?? true
  if (shouldWait) {
    reportProgress(
      input,
      'dns:wait',
      verificationDnsRecords.length > 0 ? 'DNS records saved; asking Vercel to verify ownership' : 'DNS records saved; asking Vercel to verify',
    )
  }

  const waitResult = shouldWait
    ? await waitForVercelDomainReady({
        domain: plan.domain,
        force: forceDns,
        input,
        project: plan.project,
        provider,
        providerId: plan.provider,
        records,
        zone,
        zoneDomain: plan.zoneDomain,
      })
    : {propagated: false, verified: false}

  return {
    ...plan,
    records,
    dryRun: false,
    dns: {updated: dnsResult.applied.length > 0, propagated: waitResult.propagated, skipped: dnsResult.skipped},
    vercel: {added: !addResult.alreadyAdded, alreadyAdded: addResult.alreadyAdded, verified: waitResult.verified},
  }
}
