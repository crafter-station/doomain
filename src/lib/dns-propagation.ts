import { getServers, Resolver, resolve4, resolve6, resolveCname } from 'node:dns/promises'

import { normalizeDnsValue } from './dns-records.js'
import type { DnsRecordInput, DnsRecordType } from './providers/types.js'

export interface DnsAnswer {
  ttl?: number | null
  ttlUnavailableReason?: string
  value: string
}

export interface DnsResolverObservation {
  answers: DnsAnswer[]
  elapsedMs: number
  error?: string
  errorCode?: string
  expected?: string
  kind: 'public' | 'system'
  matches?: boolean
  resolver: string
  servers: string[]
  type: DnsRecordType
}

export type DnsPropagationStatus =
  | 'local_or_vpn_cache_stale'
  | 'not_checked'
  | 'propagated'
  | 'public_propagation_pending'
  | 'system_resolver_unavailable'

export interface DnsPropagationResult {
  elapsedMs: number
  expected: string
  observations: DnsResolverObservation[]
  status: DnsPropagationStatus
  timeoutReason?: string
}

export interface DnsResolverSpec {
  kind: 'public' | 'system'
  name: string
  servers?: string[]
}

export const defaultDnsResolvers: DnsResolverSpec[] = [
  { kind: 'system', name: 'system' },
  { kind: 'public', name: 'cloudflare', servers: ['1.1.1.1', '1.0.0.1'] },
  { kind: 'public', name: 'google', servers: ['8.8.8.8', '8.8.4.4'] },
]

const negativeAnswerCodes = new Set(['ENODATA', 'ENOTFOUND'])

export function isNegativeDnsObservation(observation: DnsResolverObservation): boolean {
  return observation.errorCode !== undefined && negativeAnswerCodes.has(observation.errorCode)
}

type ResolveTarget = Pick<DnsRecordInput, 'type' | 'value'>

function resolverFor(spec: DnsResolverSpec): Resolver | undefined {
  if (!spec.servers) return undefined
  const resolver = new Resolver()
  resolver.setServers(spec.servers)
  return resolver
}

async function queryResolver(fqdn: string, type: DnsRecordType, resolver?: Resolver): Promise<DnsAnswer[]> {
  if (type === 'A') {
    const answers = resolver ? await resolver.resolve4(fqdn, { ttl: true }) : await resolve4(fqdn, { ttl: true })
    return answers.map((answer) => ({ ttl: answer.ttl, value: answer.address }))
  }
  if (type === 'AAAA') {
    const answers = resolver ? await resolver.resolve6(fqdn, { ttl: true }) : await resolve6(fqdn, { ttl: true })
    return answers.map((answer) => ({ ttl: answer.ttl, value: answer.address }))
  }
  if (type === 'CNAME') {
    const answers = resolver ? await resolver.resolveCname(fqdn) : await resolveCname(fqdn)
    return answers.map((value) => ({
      ttl: null,
      ttlUnavailableReason: 'resolver_api_does_not_expose_cname_ttl',
      value,
    }))
  }
  throw new Error(`Resolver observation is not supported for ${type} records.`)
}

export async function observeDnsRecord(
  fqdn: string,
  target: ResolveTarget,
  specs: DnsResolverSpec[] = defaultDnsResolvers,
  elapsedMs = 0,
): Promise<DnsResolverObservation[]> {
  return Promise.all(
    specs.map(async (spec) => {
      const servers = spec.servers ?? getServers()
      try {
        const answers = await queryResolver(fqdn, target.type, resolverFor(spec))
        return {
          answers,
          elapsedMs,
          expected: target.value,
          kind: spec.kind,
          matches:
            answers.length > 0 &&
            answers.every((answer) => normalizeDnsValue(answer.value) === normalizeDnsValue(target.value)),
          resolver: spec.name,
          servers,
          type: target.type,
        }
      } catch (error) {
        const errorCode =
          error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code
            : undefined
        return {
          answers: [],
          elapsedMs,
          error: error instanceof Error ? error.message : String(error),
          ...(errorCode ? { errorCode } : {}),
          expected: target.value,
          kind: spec.kind,
          matches: false,
          resolver: spec.name,
          servers,
          type: target.type,
        }
      }
    }),
  )
}

export function classifyDnsPropagation(observations: DnsResolverObservation[]): DnsPropagationStatus {
  const publicResults = observations.filter(
    (observation) => observation.kind === 'public' && (!observation.error || isNegativeDnsObservation(observation)),
  )
  const system = observations.find((observation) => observation.kind === 'system')
  const publicMatches = publicResults.length > 0 && publicResults.every((observation) => observation.matches)

  if (!publicMatches) return 'public_propagation_pending'
  if (!system || (system.error && !isNegativeDnsObservation(system))) return 'system_resolver_unavailable'
  if (!system.matches) return 'local_or_vpn_cache_stale'
  return 'propagated'
}

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

export async function waitForDnsPropagation(input: {
  fqdn: string
  record: ResolveTarget
  timeoutSeconds: number
  observe?: (fqdn: string, target: ResolveTarget, elapsedMs: number) => Promise<DnsResolverObservation[]>
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}): Promise<DnsPropagationResult> {
  const now = input.now ?? Date.now
  const wait = input.sleep ?? sleep
  const started = now()
  const deadline = started + input.timeoutSeconds * 1000
  let observations: DnsResolverObservation[] = []

  while (true) {
    const elapsedMs = now() - started
    observations = input.observe
      ? await input.observe(input.fqdn, input.record, elapsedMs)
      : await observeDnsRecord(input.fqdn, input.record, defaultDnsResolvers, elapsedMs)
    const status = classifyDnsPropagation(observations)
    if (status === 'propagated' || status === 'local_or_vpn_cache_stale' || status === 'system_resolver_unavailable') {
      return { elapsedMs, expected: input.record.value, observations, status }
    }

    const remaining = deadline - now()
    if (remaining <= 0) {
      return {
        elapsedMs: now() - started,
        expected: input.record.value,
        observations,
        status,
        timeoutReason: 'public_resolvers_did_not_match_before_timeout',
      }
    }
    await wait(Math.min(5000, remaining))
  }
}
