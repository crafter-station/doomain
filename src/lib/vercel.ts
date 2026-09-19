import { Effect } from 'effect'

import { loadConfig } from './config.js'
import type { DoomainEffect } from './effect.js'
import { DoomainError, type DoomainErrorCode, toDoomainError } from './errors.js'
import { listGlobalVercelTokens } from './vercel-auth.js'

const VERCEL_API_URL = 'https://api.vercel.com'
export const VERCEL_APEX_A_RECORD = '76.76.21.21'
export const VERCEL_CNAME_RECORD = 'cname.vercel-dns.com'

export interface VercelProject {
  id: string
  name: string
  framework: string | null
  updatedAt: number | null
}

export interface VercelTeam {
  id: string
  name: string | null
  role: string | null
  slug: string
}

export interface VercelConfig {
  token: string
  teamId?: string
}

interface VercelApiErrorBody {
  error?: {
    code?: string
    message?: string
    project?: {
      id?: string
      name?: string
    }
  }
}

type VercelAddDomainResponse = Array<Record<string, unknown>> | Record<string, unknown>

interface VercelProjectDomainOwner {
  domain: Record<string, unknown> & { name?: string; projectId?: string }
  project: VercelProject
}

interface VercelProjectsResponse {
  pagination?: {
    count?: number
    next?: number | string | null
    prev?: number | string | null
  }
  projects: Array<{ id: string; name: string; framework?: string | null; updatedAt?: number | null }>
}

interface VercelProjectDomainsResponse {
  domains?: Array<Record<string, unknown> & { name?: string; projectId?: string }>
}

interface VercelTeamsResponse {
  pagination?: {
    count?: number
    next?: number | string | null
    prev?: number | string | null
  }
  teams: Array<{ id: string; membership?: { role?: string | null }; name?: string | null; slug?: string }>
}

export function resolveVercelConfig(): DoomainEffect<VercelConfig> {
  return Effect.gen(function* () {
    const config = yield* loadConfig()
    const token = process.env.VERCEL_TOKEN || config.vercel?.token || (yield* listGlobalVercelTokens())[0]?.token
    const teamId = process.env.VERCEL_TEAM_ID || config.vercel?.teamId

    if (!token) {
      return yield* Effect.fail(
        new DoomainError(
          'MISSING_CREDENTIALS',
          'Missing Vercel token. Run `doomain auth vercel`, set VERCEL_TOKEN, or sign in with Vercel CLI.',
        ),
      )
    }

    return { token, teamId }
  })
}

function appendTeam(path: string, teamId?: string): string {
  if (!teamId) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}teamId=${encodeURIComponent(teamId)}`
}

function apiErrorMessage(status: number, body?: VercelApiErrorBody): string {
  return body?.error?.message ?? `Vercel API error (${status}).`
}

function vercelAuthErrorMessage(body?: VercelApiErrorBody): string {
  const message = body?.error?.message
  if (!message || message.toLowerCase() === 'not authorized') {
    return 'Vercel token is not authorized. Run `vercel login` again or enter a token from https://vercel.com/account/tokens.'
  }

  return `Vercel authorization failed: ${message}`
}

function isDomainConflictError(error: unknown): boolean {
  if (!(error instanceof DoomainError)) return false
  const details = error.details as VercelApiErrorBody | undefined
  const text = `${error.message} ${details?.error?.code ?? ''}`.toLowerCase()
  return (
    text.includes('already') ||
    text.includes('conflict') ||
    text.includes('domain_already') ||
    text.includes('already assigned') ||
    text.includes('already in use')
  )
}

function isSameDomain(value: unknown, domain: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === domain.toLowerCase()
}

function findProjectDomainTarget(raw: unknown, domain: string): unknown {
  const targets = Array.isArray(raw) ? raw : [raw]
  return targets.find(
    (target) =>
      target &&
      typeof target === 'object' &&
      (isSameDomain((target as Record<string, unknown>).domain, domain) ||
        isSameDomain((target as Record<string, unknown>).name, domain)),
  )
}

export function createVercelClient(config: VercelConfig, clientOpts: { transportErrorCode?: DoomainErrorCode } = {}) {
  const decodeErrorCode = clientOpts.transportErrorCode ?? 'DOMAIN_LINK_FAILED'

  function decode<A>(label: string, value: unknown, validate: (value: unknown) => A): DoomainEffect<A> {
    return Effect.try({
      try: () => validate(value),
      catch: (cause) =>
        new DoomainError(decodeErrorCode, `Vercel returned an invalid ${label} response.`, {
          cause: cause instanceof Error ? cause.message : String(cause),
          response: value,
        }),
    })
  }

  function recordResponse(label: string, value: unknown): DoomainEffect<Record<string, unknown>> {
    return decode(label, value, (candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
        throw new TypeError('Expected an object.')
      return candidate as Record<string, unknown>
    })
  }

  function request<T>(path: string, init: RequestInit = {}, opts: { team?: boolean } = {}): DoomainEffect<T> {
    return Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(`${VERCEL_API_URL}${opts.team === false ? path : appendTeam(path, config.teamId)}`, {
            ...init,
            headers: {
              Authorization: `Bearer ${config.token}`,
              'Content-Type': 'application/json',
              ...(init.headers ?? {}),
            },
            signal: init.signal ?? signal,
          }),
        catch: (cause) => toDoomainError(cause, clientOpts.transportErrorCode ?? 'DOMAIN_LINK_FAILED'),
      })
      if (!response.ok) {
        const body = yield* Effect.tryPromise(() => response.json()).pipe(
          Effect.catchAll(() => Effect.succeed(undefined)),
        )
        if (response.status === 401) {
          return yield* Effect.fail(
            new DoomainError(
              'VERCEL_AUTH_FAILED',
              vercelAuthErrorMessage(body as VercelApiErrorBody | undefined),
              body,
            ),
          )
        }

        return yield* Effect.fail(
          new DoomainError(
            'DOMAIN_LINK_FAILED',
            apiErrorMessage(response.status, body as VercelApiErrorBody | undefined),
            body,
          ),
        )
      }

      if (response.status === 204) return undefined as T
      return (yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) => toDoomainError(cause, clientOpts.transportErrorCode ?? 'DOMAIN_LINK_FAILED'),
      })) as T
    })
  }

  return {
    listTeams(): DoomainEffect<VercelTeam[]> {
      return Effect.gen(function* () {
        const teamsById = new Map<string, VercelTeam>()
        const seenCursors = new Set<string>()
        let cursor: string | undefined

        for (let page = 0; page < 25; page += 1) {
          const query = new URLSearchParams({ limit: '100' })
          if (cursor) query.set('until', cursor)

          const raw = yield* request<unknown>(`/v2/teams?${query.toString()}`, {}, { team: false })
          const result = yield* decode('teams', raw, (candidate) => {
            const response = candidate as Partial<VercelTeamsResponse> | null
            if (!response || !Array.isArray(response.teams)) throw new TypeError('Expected a teams array.')
            if (response.teams.some((team) => !team || typeof team.id !== 'string')) {
              throw new TypeError('Expected every team to have an id.')
            }
            return response as VercelTeamsResponse
          })

          for (const team of result.teams) {
            teamsById.set(team.id, {
              id: team.id,
              name: team.name ?? null,
              role: team.membership?.role ?? null,
              slug: team.slug ?? team.id,
            })
          }

          const next = result.pagination?.next?.toString()
          if (!next || seenCursors.has(next)) break

          seenCursors.add(next)
          cursor = next
        }

        return [...teamsById.values()].sort((a, b) => (a.name ?? a.slug).localeCompare(b.name ?? b.slug))
      })
    },

    listProjects(search?: string): DoomainEffect<VercelProject[]> {
      return Effect.gen(function* () {
        const projectsById = new Map<string, VercelProject>()
        const seenCursors = new Set<string>()
        let cursor: string | undefined

        for (let page = 0; page < 25; page += 1) {
          const query = new URLSearchParams({ limit: '100' })
          if (search) query.set('search', search)
          if (cursor) query.set('from', cursor)

          const raw = yield* request<unknown>(`/v9/projects?${query.toString()}`)
          const result = yield* decode('projects', raw, (candidate) => {
            const response = candidate as Partial<VercelProjectsResponse> | null
            if (!response || !Array.isArray(response.projects)) throw new TypeError('Expected a projects array.')
            if (
              response.projects.some(
                (project) => !project || typeof project.id !== 'string' || typeof project.name !== 'string',
              )
            ) {
              throw new TypeError('Expected every project to have an id and name.')
            }
            return response as VercelProjectsResponse
          })

          for (const project of result.projects) {
            projectsById.set(project.id, {
              id: project.id,
              name: project.name,
              framework: project.framework ?? null,
              updatedAt: project.updatedAt ?? null,
            })
          }

          const next = result.pagination?.next?.toString()
          if (!next || seenCursors.has(next)) break

          seenCursors.add(next)
          cursor = next
        }

        return [...projectsById.values()].sort((a, b) => a.name.localeCompare(b.name))
      })
    },

    addDomainToProject(
      project: string,
      domain: string,
      opts: { force?: boolean } = {},
    ): DoomainEffect<{ alreadyAdded: boolean; raw?: unknown }> {
      return Effect.gen(this, function* () {
        const attempted = yield* Effect.either(
          request<VercelAddDomainResponse>(`/v10/projects/${encodeURIComponent(project)}/domains`, {
            method: 'POST',
            body: JSON.stringify({ name: domain }),
          }),
        )
        if (attempted._tag === 'Right') {
          const raw = attempted.right
          const projectDomain = findProjectDomainTarget(raw, domain)
          if (!projectDomain) {
            return yield* Effect.fail(
              new DoomainError(
                'DOMAIN_LINK_FAILED',
                `Vercel did not return ${domain} after adding it to project ${project}.`,
                raw,
              ),
            )
          }

          return { alreadyAdded: false, raw: projectDomain }
        }

        const error = attempted.left
        if (isDomainConflictError(error)) {
          const projectDomain = yield* this.getProjectDomain(project, domain).pipe(
            Effect.catchAll(() => Effect.succeed(undefined)),
          )
          if (projectDomain) return { alreadyAdded: true, raw: projectDomain }

          if (opts.force) {
            const owner = yield* this.findProjectDomainOwner(domain)
            if (owner && owner.project.id !== project) {
              yield* this.removeDomainFromProject(owner.project.id, domain)
              return yield* this.addDomainToProject(project, domain)
            }
          }

          return yield* Effect.fail(
            new DoomainError(
              'DOMAIN_ALREADY_ASSIGNED',
              `Vercel reports ${domain} is already assigned to another project. Re-run with --force if you intend to move it to ${project}.`,
              error.details,
            ),
          )
        }

        return yield* Effect.fail(error)
      })
    },

    findProjectDomainOwner(domain: string): DoomainEffect<VercelProjectDomainOwner | undefined> {
      return Effect.gen(this, function* () {
        for (const project of yield* this.listProjects()) {
          const domains = yield* this.listProjectDomains(project.id).pipe(Effect.catchAll(() => Effect.succeed([])))
          const match = domains.find((item) => isSameDomain(item.name, domain))
          if (match) return { domain: match, project }
        }

        return undefined
      })
    },

    getDomainConfig(domain: string): DoomainEffect<Record<string, unknown>> {
      return request<unknown>(`/v6/domains/${encodeURIComponent(domain)}/config`).pipe(
        Effect.flatMap((value) => recordResponse('domain config', value)),
      )
    },

    getRecommendedCname(domain: string): DoomainEffect<string> {
      return this.getDomainConfig(domain).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
        Effect.map((domainConfig) => {
          const recommended = (
            domainConfig?.recommendedCNAME as Array<{ rank?: number; value?: string }> | undefined
          )?.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))[0]
          return recommended?.value?.replace(/\.$/, '') || VERCEL_CNAME_RECORD
        }),
      )
    },

    getProjectDomain(project: string, domain: string): DoomainEffect<Record<string, unknown>> {
      return request<unknown>(`/v9/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(domain)}`).pipe(
        Effect.flatMap((value) => recordResponse('project domain', value)),
      )
    },

    listProjectDomains(
      project: string,
    ): DoomainEffect<Array<Record<string, unknown> & { name?: string; projectId?: string }>> {
      return request<unknown>(`/v9/projects/${encodeURIComponent(project)}/domains`).pipe(
        Effect.flatMap((value) =>
          decode('project domains', value, (candidate) => {
            const response = candidate as Partial<VercelProjectDomainsResponse> | null
            if (!response || !Array.isArray(response.domains)) throw new TypeError('Expected a domains array.')
            return response.domains
          }),
        ),
      )
    },

    removeDomainFromProject(project: string, domain: string): DoomainEffect<void> {
      return request(`/v9/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(domain)}`, {
        method: 'DELETE',
      }).pipe(Effect.asVoid)
    },

    verifyProjectDomain(project: string, domain: string): DoomainEffect<Record<string, unknown>> {
      return request<unknown>(
        `/v9/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(domain)}/verify`,
        { method: 'POST' },
      ).pipe(Effect.flatMap((value) => recordResponse('domain verification', value)))
    },
  }
}

export type VercelClient = ReturnType<typeof createVercelClient>
