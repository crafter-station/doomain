import {loadConfig} from './config.js'
import {DmlinkError} from './errors.js'

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
  }
}

interface VercelProjectsResponse {
  pagination?: {
    count?: number
    next?: number | string | null
    prev?: number | string | null
  }
  projects: Array<{id: string; name: string; framework?: string | null; updatedAt?: number | null}>
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
    throw new DmlinkError('MISSING_CREDENTIALS', 'Missing Vercel token. Run `dmlink auth vercel` or set VERCEL_TOKEN.')
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

function isAlreadyAddedError(error: unknown): boolean {
  if (!(error instanceof DmlinkError)) return false
  const details = error.details as VercelApiErrorBody | undefined
  const text = `${error.message} ${details?.error?.code ?? ''}`.toLowerCase()
  return text.includes('already') || text.includes('conflict') || text.includes('domain_already')
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
      throw new DmlinkError('DOMAIN_LINK_FAILED', apiErrorMessage(response.status, body), body)
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

    async addDomainToProject(project: string, domain: string): Promise<{alreadyAdded: boolean; raw?: unknown}> {
      try {
        const raw = await request(`/v10/projects/${encodeURIComponent(project)}/domains`, {
          method: 'POST',
          body: JSON.stringify({name: domain}),
        })
        return {alreadyAdded: false, raw}
      } catch (error) {
        if (isAlreadyAddedError(error)) return {alreadyAdded: true, raw: error}
        throw error
      }
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

    async verifyProjectDomain(project: string, domain: string): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>(
        `/v9/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(domain)}/verify`,
        {method: 'POST'},
      )
    },
  }
}

export type VercelClient = ReturnType<typeof createVercelClient>
