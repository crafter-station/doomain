import {existsSync, readFileSync} from 'node:fs'
import {dirname, join, parse} from 'node:path'

export interface LocalVercelProject {
  projectId: string
  orgId?: string
  root: string
}

interface VercelProjectFile {
  projectId?: string
  orgId?: string
}

export function detectLocalVercelProject(start = process.cwd()): LocalVercelProject | null {
  let current = start
  const root = parse(start).root

  while (true) {
    const projectPath = join(current, '.vercel', 'project.json')
    if (existsSync(projectPath)) {
      try {
        const data = JSON.parse(readFileSync(projectPath, 'utf8')) as VercelProjectFile
        if (data.projectId) {
          return {
            projectId: data.projectId,
            orgId: data.orgId,
            root: current,
          }
        }
      } catch {
        return null
      }
    }

    if (current === root) return null
    current = dirname(current)
  }
}
