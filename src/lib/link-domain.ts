import { resolve4, resolveCname, resolveTxt } from 'node:dns/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { Effect } from 'effect'

import { loadConfig } from './config.js'
import { resolveProviderTarget } from './domain-provider.js'
import { type DoomainEffect, tryPromise } from './effect.js'
import { DoomainError } from './errors.js'
import { detectLocalVercelProject } from './local-vercel.js'
import { createProvider } from './providers/registry.js'
import type { DnsConflict, DnsProvider, DnsRecordInput, DnsZone } from './providers/types.js'
import {
  createVercelClient,
  resolveVercelConfig,
  VERCEL_APEX_A_RECORD,
  VERCEL_CNAME_RECORD,
  type VercelProject,
} from './vercel.js'

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

function resolveConfiguredDomain(domain?: string): DoomainEffect<string> {
  return Effect.gen(function* () {
    const config = yield* loadConfig()
    const resolved = domain ?? process.env.DOOMAIN_DOMAIN ?? config.defaults?.domain
    if (!resolved) {
      return yield* Effect.fail(
        new DoomainError('MISSING_ARGUMENT', 'Domain is required. Use --domain or set a default domain.'),
      )
    }
    return resolved
  })
}

function findPackageProjectName(start = process.cwd()): string | undefined {
  let current = start
  const root = parse(start).root

  while (true) {
    const packagePath = join(current, 'package.json')
    if (existsSync(packagePath)) {
      try {
        const data = JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: unknown }
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
    .map((project) => ({ project, score: projectSuggestionScore(projectName, project) }))
    .filter(({ score }) => score < 99)
    .sort((a, b) => a.score - b.score || a.project.name.localeCompare(b.project.name))
    .slice(0, 5)
    .map(({ project }) => ({ id: project.id, name: project.name }))
}

function resolvePackageProject(projectName: string): DoomainEffect<string> {
  return Effect.gen(function* () {
    const vercel = createVercelClient(yield* resolveVercelConfig())
    const projects = yield* vercel.listProjects(projectName)
    const match = projects.find((project) => project.name === projectName || project.id === projectName)
    if (match) return match.name

    const allProjects = yield* vercel.listProjects().pipe(Effect.catchAll(() => Effect.succeed([])))
    const suggestions = projectSuggestions(projectName, [...projects, ...allProjects])

    return yield* Effect.fail(
      new DoomainError(
        'VERCEL_PROJECT_NOT_LINKED',
        `No Vercel project named ${projectName} was found. Pass --project to choose a project.`,
        { project: projectName, projectSource: 'packageJson', suggestions },
      ),
    )
  })
}

function resolveProject(
  project?: string,
): DoomainEffect<{ project: string; projectSource: LinkDomainProjectSource; localProjectDetected: boolean }> {
  return Effect.gen(function* () {
    if (project) return { project, projectSource: 'flag', localProjectDetected: false }

    const config = yield* loadConfig()
    const envProject = process.env.DOOMAIN_PROJECT
    if (envProject) return { project: envProject, projectSource: 'env', localProjectDetected: false }
    if (config.defaults?.project)
      return { project: config.defaults.project, projectSource: 'config', localProjectDetected: false }

    const localProject = detectLocalVercelProject()
    if (localProject)
      return { project: localProject.projectId, projectSource: 'vercelProjectFile', localProjectDetected: true }

    const packageProject = findPackageProjectName()
    if (packageProject) {
      return {
        project: yield* resolvePackageProject(packageProject),
        projectSource: 'packageJson',
        localProjectDetected: false,
      }
    }

    return yield* Effect.fail(
      new DoomainError(
        'VERCEL_PROJECT_NOT_LINKED',
        'No Vercel project could be inferred. Run inside a project with package.json/.vercel/project.json or pass --project.',
      ),
    )
  })
}

function resolveZone(provider: DnsProvider, zoneDomain: string): DoomainEffect<DnsZone> {
  return Effect.gen(function* () {
    const zone = yield* provider.getZone(zoneDomain)
    if (!zone) {
      return yield* Effect.fail(
        new DoomainError('PROVIDER_ZONE_NOT_FOUND', `${provider.name} does not have a DNS zone for ${zoneDomain}.`),
      )
    }

    return zone
  })
}

export function withProviderRecordOptions(provider: string, record: DnsRecordInput): DnsRecordInput {
  if (provider !== 'cloudflare' || !['A', 'AAAA', 'CNAME'].includes(record.type)) return record
  return { ...record, proxied: false }
}

function planBaseRecord(opts: {
  isApex: boolean
  provider: string
  recordName: string
  cname?: string
}): DnsRecordInput {
  const record = opts.isApex
    ? ({ type: 'A', name: '@', value: VERCEL_APEX_A_RECORD, ttl: 3600 } as const)
    : ({ type: 'CNAME', name: opts.recordName, value: opts.cname ?? VERCEL_CNAME_RECORD, ttl: 3600 } as const)

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
  const nested = Object.entries(object).flatMap(([key, value]) =>
    key === 'verification' ? [] : collectVerificationRecords(value, seen),
  )
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

function mergeRecords(
  records: DnsRecordInput[],
  nextRecords: DnsRecordInput[],
): { records: DnsRecordInput[]; added: DnsRecordInput[] } {
  const existing = new Set(records.map(recordKey))
  const added = nextRecords.filter((record) => !existing.has(recordKey(record)))
  return { records: [...records, ...added], added }
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
    return [{ type: 'TXT' as const, name: cleanVerificationName(name, zoneDomain), value: record.value, ttl: 3600 }]
  })
}

function wait(milliseconds: number): DoomainEffect<void, never> {
  return Effect.sleep(milliseconds)
}

function isRecordPropagated(record: DnsRecordInput, zoneDomain: string): DoomainEffect<boolean, never> {
  const fqdn = recordFqdn(record, zoneDomain)
  return Effect.gen(function* () {
    if (record.type === 'A') {
      const values = yield* Effect.tryPromise(() => resolve4(fqdn))
      return values.includes(record.value)
    }

    if (record.type === 'CNAME') {
      const values = yield* Effect.tryPromise(() => resolveCname(fqdn))
      return values.map(cleanDnsValue).includes(cleanDnsValue(record.value))
    }

    if (record.type === 'TXT') {
      const values = (yield* Effect.tryPromise(() => resolveTxt(fqdn))).map((chunks) => chunks.join(''))
      return values.includes(record.value)
    }

    return false
  }).pipe(Effect.catchAll(() => Effect.succeed(false)))
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function areRecordsPropagated(records: DnsRecordInput[], zoneDomain: string): DoomainEffect<boolean, never> {
  return Effect.all(
    records.map((record) => isRecordPropagated(record, zoneDomain)),
    {
      concurrency: 'unbounded',
    },
  ).pipe(Effect.map((results) => results.every(Boolean)))
}

function waitForVercelDomainReady(opts: {
  domain: string
  force?: boolean
  input: LinkDomainInput
  project: string
  provider: DnsProvider
  providerId: string
  records: DnsRecordInput[]
  zone: DnsZone
  zoneDomain: string
}): DoomainEffect<{ propagated: boolean; verified: boolean }> {
  return Effect.gen(function* () {
    const vercel = createVercelClient(yield* resolveVercelConfig())
    const timeoutSeconds = opts.input.timeoutSeconds ?? 300
    const startedAt = Date.now()
    const deadline = Date.now() + timeoutSeconds * 1000
    let lastError: unknown
    let lastConfig: Record<string, unknown> | undefined
    let propagated = false
    let attempt = 1
    let records = opts.records

    function applyVerificationRecords(raw: unknown): DoomainEffect<void> {
      return Effect.gen(function* () {
        const nextRecords = planVerificationRecords(opts.providerId, raw, opts.zoneDomain)
        const merged = mergeRecords(records, nextRecords)
        if (merged.added.length === 0) return

        reportProgress(
          opts.input,
          'dns:plan',
          `Found ${merged.added.length} new Vercel ownership record${merged.added.length === 1 ? '' : 's'}`,
        )
        const dnsPlan = yield* opts.provider.planChanges(opts.zone, merged.added, { force: opts.force })
        reportProgress(opts.input, 'dns:apply', `Updating ownership records in ${opts.provider.name}`)
        yield* opts.provider.applyChanges(opts.zone, dnsPlan, { force: opts.force })
        records = merged.records
      })
    }

    function isVercelReady(raw: Record<string, unknown>): DoomainEffect<boolean> {
      return Effect.gen(function* () {
        yield* applyVerificationRecords(raw)
        if (raw.verified !== true) return false

        lastConfig = yield* vercel.getDomainConfig(opts.domain)
        return isDomainConfigReady(lastConfig)
      })
    }

    while (Date.now() <= deadline) {
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000)
      reportProgress(
        opts.input,
        'vercel:verify',
        `Verifying domain in Vercel (attempt ${attempt}, ${elapsedSeconds}s elapsed)`,
      )

      const verification = yield* Effect.gen(function* () {
        const current = yield* vercel.getProjectDomain(opts.project, opts.domain)
        if (yield* isVercelReady(current)) return true

        const result = yield* vercel.verifyProjectDomain(opts.project, opts.domain)
        return yield* isVercelReady(result)
      }).pipe(Effect.either)
      if (verification._tag === 'Right' && verification.right) return { propagated: true, verified: true }
      if (verification._tag === 'Left') {
        // Vercel returns an error while DNS is still propagating.
        lastError = verification.left
        yield* applyVerificationRecords(errorDetails(verification.left))
      }

      propagated = yield* areRecordsPropagated(records, opts.zoneDomain)
      reportProgress(
        opts.input,
        'dns:wait',
        propagated
          ? 'DNS is visible publicly; Vercel verification is still pending'
          : 'DNS records were saved; public DNS is still catching up',
      )
      attempt += 1
      if (Date.now() > deadline) break
      yield* wait(5000)
    }

    if (lastError) {
      return yield* Effect.fail(
        new DoomainError(
          'DOMAIN_VERIFY_FAILED',
          `Vercel did not verify ${opts.domain} within ${timeoutSeconds} seconds. Last Vercel response: ${errorMessage(lastError)}`,
          { domainConfig: lastConfig, error: errorDetails(lastError) },
        ),
      )
    }

    if (lastConfig?.misconfigured === true) {
      return yield* Effect.fail(
        new DoomainError(
          'DOMAIN_VERIFY_FAILED',
          `Vercel verified ${opts.domain}, but its DNS configuration is still invalid after ${timeoutSeconds} seconds.`,
          { domainConfig: lastConfig },
        ),
      )
    }

    return { propagated, verified: false }
  })
}

function reportProgress(input: LinkDomainInput, stage: LinkDomainProgressStage, message: string): void {
  input.progress?.({ message, stage })
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
      recovery:
        'Confirm the DNS override in interactive mode, or re-run with --force to overwrite conflicting DNS records.',
      recordName: warning.recordName,
      suggestedCommands: [`doomain link ${warning.domain} --project <project> --force --json`],
      zoneDomain: warning.zoneDomain,
    },
  )
}

function resolveDnsForce(
  input: LinkDomainInput,
  opts: { baseRecord: DnsRecordInput; plan: LinkDomainPlan; provider: DnsProvider; zone: DnsZone },
): DoomainEffect<boolean> {
  return Effect.gen(function* () {
    reportProgress(input, 'dns:inspect', `Checking existing DNS records in ${opts.provider.name}`)
    const dnsPlan = yield* opts.provider.planChanges(opts.zone, [opts.baseRecord], { force: input.force })

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
    const confirmed = input.confirmDnsOverride
      ? yield* tryPromise(() => input.confirmDnsOverride?.(warning) ?? Promise.resolve(false), 'DOMAIN_LINK_FAILED')
      : false
    if (!confirmed) return yield* Effect.fail(dnsTargetConflictError(warning))

    return true
  })
}

export function createLinkPlan(input: LinkDomainInput): DoomainEffect<LinkDomainPlan> {
  return Effect.gen(function* () {
    const domain = yield* resolveConfiguredDomain(input.domain)
    const project = yield* resolveProject(input.project)
    const resolved = yield* resolveProviderTarget({ ...input, domain }, { transportErrorCode: 'DOMAIN_LINK_FAILED' })
    const { account, accountInferred, isDefaultAccount, provider, providerInferred, target } = resolved
    const record = planBaseRecord({ isApex: target.isApex, provider, recordName: target.recordName })

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
  })
}

export function linkDomain(input: LinkDomainInput): DoomainEffect<LinkDomainResult> {
  return Effect.gen(function* () {
    const plan = yield* createLinkPlan(input)

    if (input.dryRun) {
      return {
        ...plan,
        dryRun: true,
        dns: { updated: false, propagated: false, skipped: [] },
        vercel: { added: false, alreadyAdded: false, verified: false },
      }
    }

    const vercel = createVercelClient(yield* resolveVercelConfig())
    const provider = yield* createProvider(plan.provider, {
      account: plan.account,
      transportErrorCode: 'DOMAIN_LINK_FAILED',
    })
    reportProgress(input, 'dns:resolve-zone', `Finding ${provider.name} DNS zone`)
    const zone = yield* resolveZone(provider, plan.zoneDomain)
    reportProgress(input, 'vercel:get-target', 'Reading Vercel DNS target')
    const cname = plan.isApex ? undefined : yield* vercel.getRecommendedCname(plan.domain)
    const baseRecord = planBaseRecord({
      isApex: plan.isApex,
      provider: plan.provider,
      recordName: plan.recordName,
      cname,
    })
    const forceDns = yield* resolveDnsForce(input, { baseRecord, plan, provider, zone })
    reportProgress(input, 'vercel:add-domain', 'Adding domain to Vercel')
    const addResult = yield* vercel.addDomainToProject(plan.project, plan.domain, { force: input.force })
    reportProgress(input, 'vercel:get-domain', 'Reading Vercel verification records')
    const projectDomain = yield* vercel.getProjectDomain(plan.project, plan.domain)
    const verificationDnsRecords = uniqueRecords([
      ...planVerificationRecords(plan.provider, addResult.raw, plan.zoneDomain),
      ...planVerificationRecords(plan.provider, projectDomain, plan.zoneDomain),
    ])
    const records = [baseRecord, ...verificationDnsRecords]
    reportProgress(input, 'dns:plan', `Reading ${provider.name} DNS records`)
    const dnsPlan = yield* provider.planChanges(zone, records, { force: forceDns })
    reportProgress(input, 'dns:apply', `Updating DNS records in ${provider.name}`)
    const dnsResult = yield* provider.applyChanges(zone, dnsPlan, { force: forceDns })

    const shouldWait = input.wait ?? true
    if (shouldWait) {
      reportProgress(
        input,
        'dns:wait',
        verificationDnsRecords.length > 0
          ? 'DNS records saved; asking Vercel to verify ownership'
          : 'DNS records saved; asking Vercel to verify',
      )
    }

    const waitResult = shouldWait
      ? yield* waitForVercelDomainReady({
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
      : { propagated: false, verified: false }

    return {
      ...plan,
      records,
      dryRun: false,
      dns: { updated: dnsResult.applied.length > 0, propagated: waitResult.propagated, skipped: dnsResult.skipped },
      vercel: { added: !addResult.alreadyAdded, alreadyAdded: addResult.alreadyAdded, verified: waitResult.verified },
    }
  })
}
