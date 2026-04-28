import {loadConfig} from './config.js'
import {DoomainError} from './errors.js'

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

type VercelAliasResponse = Array<Record<string, unknown>> | Record<string, unknown>

interface VercelProjectDomainOwner {
  domain: Record<string, unknown> & {name?: string; projectId?: string}
  project: VercelProject
}

interface VercelProjectsResponse {
  pagination?: {
    count?: number
    next?: number | string | null
    prev?: number | string | null
  }
  projects: Array<{id: string; name: string; framework?: string | null; updatedAt?: number | null}>
}

interface VercelProjectDomainsResponse {
  domains?: Array<Record<string, unknown> & {name?: string; projectId?: string}>
}

interface VercelTeamsResponse {
  pagination?: {
    count?: number
    next?: number | string | null
    prev?: number | string | null
  }
  teams: Array<{id: string; membership?: {role?: string | null}; name?: string | null; slug?: string}>
}

export async function resolveVercelConfig(): Promise<VercelConfig> {
  const config = await loadConfig()
  const token = process.env.VERCEL_TOKEN || config.vercel?.token
  const teamId = process.env.VERCEL_TEAM_ID || config.vercel?.teamId

  if (!token) {
    throw new DoomainError('MISSING_CREDENTIALS', 'Missing Vercel token. Run `doomain auth vercel` or set VERCEL_TOKEN.')
  }

  return {token, teamId}
}

function appendTeam(path: string, teamId?: string): string {
  if (!teamId) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}teamId=${encodeURIComponent(teamId)}`
}

function apiErrorMessage(status: number, body?: VercelApiErrorBody): string {
  return body?.error?.message ?? `Vercel API error (${status}).`
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

function findAliasTarget(raw: unknown, domain: string): unknown {
  const targets = Array.isArray(raw) ? raw : [raw]
  return targets.find((target) => target && typeof target === 'object' && isSameDomain((target as Record<string, unknown>).domain, domain))
}

export function createVercelClient(config: VercelConfig) {
  async function request<T>(path: string, init: RequestInit = {}, opts: {team?: boolean} = {}): Promise<T> {
    const response = await fetch(`${VERCEL_API_URL}${opts.team === false ? path : appendTeam(path, config.teamId)}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    })

    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as VercelApiErrorBody | undefined
      throw new DoomainError('DOMAIN_LINK_FAILED', apiErrorMessage(response.status, body), body)
    }

    if (response.status === 204) return undefined as T
    return (await response.json().catch(() => undefined)) as T
  }

  return {
    async listTeams(): Promise<VercelTeam[]> {
      const teamsById = new Map<string, VercelTeam>()
      const seenCursors = new Set<string>()
      let cursor: string | undefined

      for (let page = 0; page < 25; page += 1) {
        const query = new URLSearchParams({limit: '100'})
        if (cursor) query.set('until', cursor)

        const result = await request<VercelTeamsResponse>(`/v2/teams?${query.toString()}`, {}, {team: false})

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
    },

    async listProjects(search?: string): Promise<VercelProject[]> {
      const projectsById = new Map<string, VercelProject>()
      const seenCursors = new Set<string>()
      let cursor: string | undefined

      for (let page = 0; page < 25; page += 1) {
        const query = new URLSearchParams({limit: '100'})
        if (search) query.set('search', search)
        if (cursor) query.set('from', cursor)

        const result = await request<VercelProjectsResponse>(`/v9/projects?${query.toString()}`)

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
    },

    async addDomainToProject(project: string, domain: string, opts: {force?: boolean} = {}): Promise<{alreadyAdded: boolean; raw?: unknown}> {
      try {
        const raw = await request<VercelAliasResponse>(`/projects/${encodeURIComponent(project)}/alias`, {
          method: 'POST',
          body: JSON.stringify({domain, target: 'PRODUCTION'}),
        })
        const aliasTarget = findAliasTarget(raw, domain)
        if (!aliasTarget) {
          throw new DoomainError(
            'DOMAIN_LINK_FAILED',
            `Vercel did not return ${domain} after adding it to project ${project}.`,
            raw,
          )
        }

        return {alreadyAdded: false, raw: aliasTarget}
      } catch (error) {
        if (isDomainConflictError(error)) {
          const projectDomain = await this.getProjectDomain(project, domain).catch(() => undefined)
          if (projectDomain) return {alreadyAdded: true, raw: projectDomain}

          if (opts.force) {
            const owner = await this.findProjectDomainOwner(domain)
            if (owner && owner.project.id !== project) {
              await this.removeDomainFromProject(owner.project.id, domain)
              return this.addDomainToProject(project, domain)
            }
          }

          throw new DoomainError(
            'DOMAIN_ALREADY_ASSIGNED',
            `Vercel reports ${domain} is already assigned to another project. Re-run with --force if you intend to move it to ${project}.`,
            error instanceof DoomainError ? error.details : undefined,
          )
        }

        throw error
      }
    },

    async findProjectDomainOwner(domain: string): Promise<VercelProjectDomainOwner | undefined> {
      for (const project of await this.listProjects()) {
        const domains = await this.listProjectDomains(project.id).catch(() => [])
        const match = domains.find((item) => isSameDomain(item.name, domain))
        if (match) return {domain: match, project}
      }

      return undefined
    },

    async getDomainConfig(domain: string): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>(`/v6/domains/${encodeURIComponent(domain)}/config`)
    },

    async getRecommendedCname(domain: string): Promise<string> {
      const config = await this.getDomainConfig(domain).catch(() => undefined)
      const recommended = (config?.recommendedCNAME as Array<{rank?: number; value?: string}> | undefined)?.sort(
        (a, b) => (a.rank ?? 999) - (b.rank ?? 999),
      )[0]

      return recommended?.value?.replace(/\.$/, '') || VERCEL_CNAME_RECORD
    },

    async getProjectDomain(project: string, domain: string): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>(
        `/v9/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(domain)}`,
      )
    },

    async listProjectDomains(project: string): Promise<Array<Record<string, unknown> & {name?: string; projectId?: string}>> {
      const result = await request<VercelProjectDomainsResponse>(`/v9/projects/${encodeURIComponent(project)}/domains`)
      return result.domains ?? []
    },

    async removeDomainFromProject(project: string, domain: string): Promise<void> {
      await request(`/projects/${encodeURIComponent(project)}/alias?domain=${encodeURIComponent(domain)}`, {method: 'DELETE'})
    },

    async verifyProjectDomain(project: string, domain: string): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>(
        `/v9/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(domain)}/verify`,
        {method: 'POST'},
      )
    },
  }
}

export type VercelClient = ReturnType<typeof createVercelClient>
